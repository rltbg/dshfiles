/**
 * `ctx.subprocess` for threads that run in a sandbox. It extends the dshfiles local runtime and calls it unchanged
 * when the working folder belongs to no sandbox. A process whose working folder is inside a sandbox's workspace runs
 * in that sandbox through its guest agent, with the same stdio dispositions, bounded collection, spill files,
 * cancellation and TERM-then-KILL escalation as a local one.
 */
import { basename, isAbsolute } from 'node:path'
import { PassThrough, type Readable, type Writable } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import { SubprocessError } from '@deepseek-ai/dsh-subprocess'
import type {
  SubprocessCollect,
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessOutputMode,
  SubprocessSpawnSpec,
  SubprocessTerminalHandle,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { GuestError, type GuestProcess } from '@dshfiles/sandbox-guest/channel'
import { OutputCollector, logSpillFailure, prepareManagedProcessBinding, type SpillFailureReporter } from '@dshfiles/subprocess-local/output'
import LocalSubprocessRuntime from '@dshfiles/subprocess-local/runtime'
import type { SandboxRoute } from './routes.ts'

/**
 * Variables that describe the Host, not the sandbox. The sandbox image sets its own; forwarding the Host's would point
 * `PATH` at folders the sandbox does not have and leak the Host user's home.
 */
const HOST_ONLY_VARIABLES = new Set(['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'USER', 'LOGNAME', 'SHELL', 'PWD', 'OLDPWD', 'XDG_RUNTIME_DIR'])

const isCollect = (mode: SubprocessOutputMode): mode is SubprocessCollect => mode !== 'pipe' && mode !== 'inherit'

/** The environment a sandboxed process receives: the caller's explicit variables, minus the Host-only ones. */
const sandboxEnvironment = (env: NodeJS.ProcessEnv | undefined) =>
  Object.fromEntries(Object.entries(env ?? {}).filter((entry): entry is [string, string] => entry[1] !== undefined && !HOST_ONLY_VARIABLES.has(entry[0])))

/**
 * A caller that resolved its program on the Host (`/usr/bin/git`) means the same command in the sandbox, found on the
 * sandbox's own `PATH`; a program inside the workspace keeps its path, which is the same in the sandbox.
 */
const sandboxArgv = (argv: readonly string[], route: SandboxRoute): string[] => {
  const [program, ...rest] = argv
  if (program === undefined) throw new SubprocessError('cannot spawn an empty argv', 'SUBPROCESS_INVALID_ARGV')
  const inWorkspace = program.startsWith(`${route.root}/`)
  return [isAbsolute(program) && !inWorkspace ? basename(program) : program, ...rest]
}

/** The collect-mode readers of one routed process, present only for the streams the caller asked to collect. */
interface RoutedCollectors {
  stdout?: OutputCollector
  stderr?: OutputCollector
}

class RoutedProcess {
  readonly handle: SubprocessHandle
  private guest: GuestProcess | undefined
  private exited = false
  private terminating = false
  private readonly spec: SubprocessSpawnSpec

  constructor(route: SandboxRoute, spec: SubprocessSpawnSpec, spill: { readonly dir: string; readonly onFailure: SpillFailureReporter }) {
    this.spec = spec
    const stdin = spec.stdio.stdin === 'pipe' ? new PassThrough() : undefined
    const output = (mode: SubprocessOutputMode, label: 'stdout' | 'stderr') => {
      const stream = new PassThrough()
      const collector = isCollect(mode)
        ? new OutputCollector(
            mode.maxBytes,
            label,
            mode.spill === undefined ? undefined : { maxBytes: mode.spill.maxBytes, dir: spill.dir, onFailure: spill.onFailure },
          )
        : undefined
      if (collector !== undefined) stream.on('data', (chunk: Buffer) => collector.push(chunk))
      else if (mode === 'inherit') stream.pipe(label === 'stdout' ? process.stdout : process.stderr, { end: false })
      return { stream, collector }
    }
    const stdout = output(spec.stdio.stdout, 'stdout')
    const stderr = output(spec.stdio.stderr, 'stderr')

    const onAbort = (): void => this.terminate()
    spec.signal?.addEventListener('abort', onAbort, { once: true })

    const done = (async (): Promise<SubprocessOutcome> => {
      try {
        const guest = await route.channel.spawn({ argv: sandboxArgv(spec.argv, route), cwd: spec.cwd, env: sandboxEnvironment(spec.env) })
        this.guest = guest
        guest.stdout.pipe(stdout.stream)
        guest.stderr.pipe(stderr.stream)
        this.connectStdin(guest.stdin, stdin)
        // A terminate() that arrived while the process was starting applies now.
        if (this.terminating) guest.kill('SIGTERM', spec.graceMs)
        const exit = await guest.done
        await Promise.all([RoutedProcess.ended(stdout.stream), RoutedProcess.ended(stderr.stream)])
        return { exitCode: exit.exitCode, signal: exit.signal }
      } catch (error) {
        stdout.stream.end()
        stderr.stream.end()
        throw RoutedProcess.spawnFailure(error, route, spec.argv[0] ?? '')
      } finally {
        this.exited = true
        spec.signal?.removeEventListener('abort', onAbort)
        stdout.collector?.seal()
        stderr.collector?.seal()
      }
    })()
    // The caller observes failures through `done`; an unobserved rejection must not take the Host down.
    done.catch(() => undefined)

    const collected: RoutedCollectors = {}
    if (stdout.collector !== undefined) collected.stdout = stdout.collector
    if (stderr.collector !== undefined) collected.stderr = stderr.collector
    this.handle = {
      stdin,
      stdout: spec.stdio.stdout === 'pipe' ? stdout.stream : undefined,
      stderr: spec.stdio.stderr === 'pipe' ? stderr.stream : undefined,
      control: undefined,
      collected,
      done,
      terminate: () => this.terminate(),
      waitForExit: signal => this.waitForExit(done, signal),
    }
  }

  /**
   * TERM the process group now; the guest agent KILLs it after the grace period if it is still running, so the
   * escalation holds even when the Host goes away meanwhile.
   */
  terminate(): void {
    if (this.exited || this.terminating) return
    this.terminating = true
    this.guest?.kill('SIGTERM', this.spec.graceMs)
  }

  private connectStdin(target: Writable, source: PassThrough | undefined): void {
    target.on('error', () => undefined)
    const mode = this.spec.stdio.stdin
    if (typeof mode === 'object') target.end(mode.data)
    else if (source === undefined) target.end()
    else source.pipe(target)
  }

  private async waitForExit(done: Promise<SubprocessOutcome>, signal: AbortSignal | undefined): Promise<boolean> {
    const settled = done.then(
      () => true,
      () => true,
    )
    if (signal === undefined) return settled
    if (signal.aborted) return this.exited
    return Promise.race([settled, new Promise<boolean>(resolve => signal.addEventListener('abort', () => resolve(this.exited), { once: true }))])
  }

  private static ended(stream: Readable): Promise<void> {
    if (stream.readableEnded) return Promise.resolve()
    return new Promise(resolve => {
      stream.once('end', resolve)
      stream.once('close', resolve)
      stream.resume()
    })
  }

  private static spawnFailure(error: unknown, route: SandboxRoute, program: string): Error {
    if (!(error instanceof GuestError)) return error instanceof Error ? error : new Error(String(error))
    if (error.code === 'GUEST_CLOSED')
      return new SubprocessError(
        `sandbox ${route.id} is no longer reachable, so ${program} did not run. Start the sandbox again from the Sandboxes page (or the sandbox_start tool), then retry.`,
        'SUBPROCESS_SPAWN_FAILED',
        { cause: error },
      )
    if (error.code === 'FS_NOT_FOUND' || error.code === 'FS_NOT_DIRECTORY')
      return new SubprocessError(`cannot run ${program} in sandbox ${route.id}: ${error.message}`, 'SUBPROCESS_SPAWN_NOT_FOUND', { cause: error })
    return new SubprocessError(`cannot run ${program} in sandbox ${route.id}: ${error.message}`, 'SUBPROCESS_SPAWN_FAILED', { cause: error })
  }
}

export class RoutedSubprocessRuntime extends LocalSubprocessRuntime {
  static inject = ['sandboxRoutes']

  private readonly routedLive = new Set<RoutedProcess>()
  private readonly reportRoutedSpill: SpillFailureReporter

  constructor(ctx: Context) {
    super(ctx)
    this.reportRoutedSpill = logSpillFailure(ctx.logger, 'sandbox-seams')
    ctx.effect(() => () => {
      for (const process of this.routedLive) process.terminate()
    })
  }

  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    const route = this.ctx.sandboxRoutes.forPath(spec.cwd)
    if (route === undefined) return super.spawn(spec)
    if (spec.stdio.control === 'pipe')
      throw new SubprocessError(
        `a control channel is not available for processes in sandbox ${route.id}; run the command without it`,
        'SUBPROCESS_SPAWN_FAILED',
      )
    if (spec.signal?.aborted === true) throw new Error(`aborted before spawn: ${String(spec.signal.reason ?? 'aborted')}`)
    const { spillDir } = prepareManagedProcessBinding({})
    const process = new RoutedProcess(route, spec, { dir: spillDir, onFailure: this.reportRoutedSpill })
    this.routedLive.add(process)
    const release = (): void => {
      this.routedLive.delete(process)
    }
    process.handle.done.then(release, release)
    return process.handle
  }

  override spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    const route = this.ctx.sandboxRoutes.forPath(spec.cwd)
    if (route === undefined) return super.spawnTerminal(spec)
    return Promise.reject(
      new SubprocessError(
        `an interactive terminal is not available inside sandbox ${route.id} yet; run commands with the bash tool, or open a terminal in a thread without a sandbox`,
        'SUBPROCESS_PTY_UNAVAILABLE',
      ),
    )
  }
}

export default RoutedSubprocessRuntime
