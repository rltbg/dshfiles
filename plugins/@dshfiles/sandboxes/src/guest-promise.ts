/**
 * The Promise edge of the plugin: the guest channel and the Host subprocess handles it rides on are Promise APIs, and
 * this file is the one place they become Effects.
 */
import type { SubprocessHandle, SubprocessRuntime, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { GuestChannel, GuestError, type GuestProcess as GuestProcessHandle } from '@dshfiles/sandbox-guest/channel'
import type { GuestArguments, GuestHello, GuestOperation } from '@dshfiles/sandbox-guest/protocol'
import { Duration, Effect } from 'effect'
import { SandboxStepFailed } from './errors.ts'

export interface GuestRun {
  readonly exitCode: number | null
  readonly stdout: Uint8Array
  readonly stderr: string
}

export interface GuestRunInput {
  readonly argv: readonly string[]
  readonly cwd: string
  readonly stdin?: Uint8Array
  readonly env?: Readonly<Record<string, string>>
  /** Output beyond this many bytes fails the run instead of being buffered. */
  readonly maxStdoutBytes?: number
}

const DEFAULT_MAX_STDOUT = 16 * 1024 * 1024

const failure = (id: string, step: string, recovery: string) => (cause: unknown) =>
  new SandboxStepFailed({ id, step, detail: cause instanceof Error ? cause.message : String(cause), recovery, cause })

/** A Host process whose stdin and stdout carry a guest channel. */
export interface GuestProcess {
  readonly handle: SubprocessHandle
  readonly channel: GuestChannel
}

export class GuestEdge {
  /** Start a Host process (an engine's `run -i`, a local agent) through `ctx.subprocess` and open its channel. */
  static spawn(id: string, subprocess: SubprocessRuntime, spec: SubprocessSpawnSpec): Effect.Effect<GuestProcess, SandboxStepFailed> {
    return Effect.try({
      try: () => subprocess.spawn(spec),
      catch: failure(id, 'start', 'Check that the container engine or Node is installed and on PATH (sandbox_doctor), then retry.'),
    }).pipe(
      Effect.flatMap(handle => {
        const { stdin, stdout } = handle
        if (stdin !== undefined && stdout !== undefined) return Effect.succeed({ handle, channel: new GuestChannel({ input: stdin, output: stdout }) })
        handle.terminate()
        return Effect.fail(
          new SandboxStepFailed({ id, step: 'start', detail: 'the sandbox process has no stdio pipes', recovery: 'Report this; it is a bug.' }),
        )
      }),
    )
  }

  /** Wait for the guest agent's greeting. */
  static hello(id: string, process: GuestProcess, timeout: Duration.Input): Effect.Effect<GuestHello, SandboxStepFailed> {
    return Effect.tryPromise({
      try: () => process.channel.hello,
      catch: failure(id, 'start', 'Read the sandbox logs (sandbox_logs) for why its guest agent did not start, fix the image, then retry.'),
    }).pipe(
      Effect.timeoutOrElse({
        duration: timeout,
        orElse: () =>
          Effect.fail(
            new SandboxStepFailed({
              id,
              step: 'start',
              detail: `the guest agent did not answer within ${Duration.format(Duration.fromInputUnsafe(timeout))}`,
              recovery: 'Pull or build the image first (sandbox_doctor shows the command), then start the sandbox again.',
            }),
          ),
      }),
    )
  }

  /** The process's collected stderr: the guest agent's diagnostics, or the engine's own refusal. */
  static stderr(process: GuestProcess): Effect.Effect<string> {
    return Effect.sync(() => process.handle.collected.stderr?.readFrom(0).text ?? '')
  }

  /** Close the channel (the guest stops its processes and exits), then wait for the Host process, killing it if it lingers. */
  static close(process: GuestProcess): Effect.Effect<void> {
    return Effect.tryPromise(() => process.channel.close()).pipe(
      Effect.andThen(Effect.tryPromise(() => process.handle.done)),
      Effect.timeout(Duration.seconds(10)),
      Effect.catch(() => Effect.sync(() => process.handle.terminate())),
      Effect.asVoid,
    )
  }

  /** Run one command in the sandbox to completion, feeding `stdin` and collecting its output. */
  static readonly run = Effect.fn('sandbox guest run')(function* (id: string, step: string, channel: GuestChannel, input: GuestRunInput) {
    const max = input.maxStdoutBytes ?? DEFAULT_MAX_STDOUT
    return yield* Effect.tryPromise({
      try: async (): Promise<GuestRun> => {
        const process = await channel.spawn(
          input.env === undefined ? { argv: input.argv, cwd: input.cwd } : { argv: input.argv, cwd: input.cwd, env: input.env },
        )
        const chunks: Buffer[] = []
        let size = 0
        let stderr = ''
        process.stdout.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > max) process.kill('SIGKILL')
          else chunks.push(chunk)
        })
        process.stderr.on('data', (chunk: Buffer) => {
          if (stderr.length < 64_000) stderr += chunk.toString()
        })
        const ended = (stream: NodeJS.ReadableStream) => new Promise<void>(resolve => stream.once('end', () => resolve()))
        const outputs = Promise.all([ended(process.stdout), ended(process.stderr)])
        process.stdin.end(input.stdin === undefined ? undefined : Buffer.from(input.stdin))
        const exit = await process.done
        await outputs
        if (size > max) throw new Error(`the output passed ${max} bytes`)
        return { exitCode: exit.exitCode, stdout: Buffer.concat(chunks), stderr }
      },
      catch: cause =>
        new SandboxStepFailed({
          id,
          step,
          detail: cause instanceof GuestError ? `${cause.code}: ${cause.message}` : cause instanceof Error ? cause.message : String(cause),
          recovery:
            cause instanceof GuestError && cause.code === 'GUEST_CLOSED'
              ? 'Start the sandbox again, then retry.'
              : 'Read the sandbox logs (sandbox_logs), then retry.',
          cause,
        }),
    })
  })

  /** One request on the channel; a guest failure becomes the step's error. */
  static request<K extends GuestOperation>(id: string, step: string, channel: GuestChannel, op: K, args: GuestArguments[K]) {
    return Effect.tryPromise({
      try: () => channel.request(op, args),
      catch: failure(id, step, 'Read the sandbox logs (sandbox_logs), then retry.'),
    })
  }

  /** Start a long-lived process in the sandbox; the caller stops it with `kill`. */
  static start(id: string, step: string, channel: GuestChannel, input: GuestArguments['spawn']): Effect.Effect<GuestProcessHandle, SandboxStepFailed> {
    return Effect.tryPromise({
      try: async () => {
        const started = await channel.spawn(input)
        started.stdin.end()
        // Its output is diagnostics only; reading it keeps the guest from buffering it.
        started.stdout.resume()
        started.stderr.resume()
        return started
      },
      catch: failure(id, step, 'Read the sandbox logs (sandbox_logs); the image may not be the runtime image.'),
    })
  }

  /** {@link run}, failing unless the command exits 0. */
  static readonly exec = Effect.fn('sandbox guest exec')(function* (id: string, step: string, channel: GuestChannel, input: GuestRunInput) {
    const result = yield* GuestEdge.run(id, step, channel, input)
    if (result.exitCode === 0) return result
    return yield* new SandboxStepFailed({
      id,
      step,
      detail: `${input.argv[0] ?? 'the command'} exited ${String(result.exitCode)}: ${result.stderr.trim().slice(-400)}`,
      recovery: 'Read the sandbox logs (sandbox_logs); the image may lack git or bash.',
    })
  })
}
