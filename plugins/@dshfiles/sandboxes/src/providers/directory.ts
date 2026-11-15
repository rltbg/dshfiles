/**
 * A sandbox that is a plain folder on this machine, served by a guest agent confined to it. It isolates nothing: a
 * process can read and write anything the user can. It exists to develop and test the orchestrator without a
 * container engine, and is chosen only by the `directory` setting, never by `auto`.
 */
import { Duration, Effect, FileSystem } from 'effect'
import { hostService } from '@dshfiles/dshx/effect/host-context'
import { SandboxStepFailed } from '../errors.ts'
import { GuestEdge } from '../guest-promise.ts'
import { SandboxPaths } from '../paths.ts'
import type { ProviderReadiness, SandboxMode, SandboxProvider, SandboxSpec, StartedSandbox } from '../port.ts'

const MARKER = '.directory-sandbox'

export class DirectoryProvider {
  static readonly make = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const paths = yield* SandboxPaths
    const subprocess = yield* hostService('subprocess').pipe(Effect.orDie)

    const failed = (spec: SandboxSpec, step: string) => (cause: unknown) =>
      new SandboxStepFailed({
        id: spec.id,
        step,
        detail: cause instanceof Error ? cause.message : String(cause),
        recovery: `Check that ${paths.root} is writable, then retry.`,
        cause,
      })

    const describe = (mode: SandboxMode): Effect.Effect<ProviderReadiness> =>
      Effect.succeed(
        mode === 'runtime'
          ? {
              provider: 'directory',
              mode,
              ready: false,
              isolation: 'none',
              detail: 'A plain folder cannot hold a DSH runtime of its own.',
              fix: 'Use the container provider for runtime-mode sandboxes.',
            }
          : { provider: 'directory', mode, ready: true, isolation: 'none', detail: 'A plain folder on this machine, with no isolation.' },
      )

    const create = Effect.fn('sandbox directory create')(function* (spec: SandboxSpec) {
      yield* fs.makeDirectory(spec.workspace, { recursive: true }).pipe(Effect.mapError(failed(spec, 'create')))
      yield* fs.writeFileString(`${paths.root}/${spec.id}/${MARKER}`, '').pipe(Effect.mapError(failed(spec, 'create')))
    })

    const start = Effect.fn('sandbox directory start')(function* (spec: SandboxSpec) {
      const source = yield* paths.agentSource
      const process = yield* GuestEdge.spawn(spec.id, subprocess, {
        argv: [globalThis.process.execPath, '--input-type=module', '-e', source, '--', '--root', spec.workspace, '--confine'],
        cwd: spec.workspace,
        stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 64_000 } },
        graceMs: 2_000,
        // The Host environment, minus what `ctx.subprocess` scrubs; its `GIT_CONFIG_KEY_<n>` are gone, so the count goes too.
        env: { GIT_CONFIG_COUNT: '0' },
      })
      yield* GuestEdge.hello(spec.id, process, Duration.seconds(10)).pipe(Effect.tapError(() => GuestEdge.close(process)))
      const started: StartedSandbox = { channel: process.channel, logs: GuestEdge.stderr(process), stop: GuestEdge.close(process) }
      return started
    })

    const destroy = Effect.fn('sandbox directory destroy')(function* (spec: SandboxSpec) {
      yield* fs.remove(spec.workspace, { recursive: true, force: true }).pipe(Effect.mapError(failed(spec, 'destroy')))
      yield* fs.remove(`${paths.root}/${spec.id}/${MARKER}`, { force: true }).pipe(Effect.mapError(failed(spec, 'destroy')))
    })

    const list = Effect.gen(function* () {
      const exists = yield* fs.exists(paths.root).pipe(Effect.orElseSucceed(() => false))
      if (!exists) return []
      const entries = yield* fs.readDirectory(paths.root).pipe(Effect.orElseSucceed(() => []))
      return yield* Effect.filter(entries, entry => fs.exists(`${paths.root}/${entry}/${MARKER}`).pipe(Effect.orElseSucceed(() => false)), {
        concurrency: 8,
      })
    })

    const provider: SandboxProvider = { id: 'directory', describe, create, start, destroy, list }
    return provider
  })
}
