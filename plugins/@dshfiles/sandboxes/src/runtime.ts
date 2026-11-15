/**
 * The DSH runtime inside a runtime-mode sandbox (remote mode A). The whole agent runs there; this machine only carries
 * bytes. The runtime starts as a process in the sandbox, publishes its tokenized loopback URL in its own
 * `plugins/multi-host/launch.json`, and this machine republishes it at the same path, with the port of a loopback
 * forward over the sandbox's channel. multi-host then registers that home as a runtime on this host, over SSH or
 * locally, like any DSH on it.
 */
import type { GuestChannel } from '@dshfiles/sandbox-guest/channel'
import { decodeJsonSafe } from '@dshfiles/dshx/json'
import { Context, Duration, Effect, FileSystem, Layer, Schedule, Schema } from 'effect'
import { SandboxStepFailed } from './errors.ts'
import { LoopbackForwards } from './forward-promise.ts'
import { GuestEdge } from './guest-promise.ts'

const LAUNCH_URL = /^http:\/\/127\.0\.0\.1:(\d{1,5})\/\?token=([A-Za-z0-9._~-]{8,512})$/u
const launchRecord = Schema.Struct({ schemaVersion: Schema.Literal(1), launchUrl: Schema.String })

export interface RuntimeTarget {
  readonly id: string
  readonly channel: GuestChannel
  readonly workspace: string
  /** The runtime's DSH home: the same absolute path inside the sandbox and on this machine. */
  readonly home: string
}

export interface StartedRuntime {
  /** The loopback port on this machine that reaches the runtime. */
  readonly port: number
  readonly stop: Effect.Effect<void>
}

const launchFile = (home: string): string => `${home}/plugins/multi-host/launch.json`

export class SandboxRuntimes extends Context.Service<
  SandboxRuntimes,
  { readonly start: (target: RuntimeTarget) => Effect.Effect<StartedRuntime, SandboxStepFailed> }
>()('@dshfiles/sandboxes/SandboxRuntimes') {
  static readonly layer = Layer.effect(
    SandboxRuntimes,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem

      const failed = (id: string, detail: string, recovery: string) => new SandboxStepFailed({ id, step: 'start its DSH runtime', detail, recovery })

      /** The runtime's own launch URL, once it has written one. */
      const innerLaunch = (target: RuntimeTarget) =>
        GuestEdge.request(target.id, 'start its DSH runtime', target.channel, 'read', { path: launchFile(target.home) }).pipe(
          Effect.flatMap(read => {
            const record = decodeJsonSafe(launchRecord, Buffer.from(read.data, 'base64').toString('utf8'))
            const match = record._tag === 'Success' ? LAUNCH_URL.exec(record.success.launchUrl) : null
            return match === null || match[1] === undefined || match[2] === undefined
              ? Effect.fail(failed(target.id, 'its launch file is not a loopback launch URL', 'Rebuild the runtime image, then start the sandbox again.'))
              : Effect.succeed({ port: Number(match[1]), token: match[2] })
          }),
        )

      const start = Effect.fn('sandbox runtime start')(function* (target: RuntimeTarget) {
        // A launch file left by an earlier run would point at a port nothing listens on any more.
        yield* GuestEdge.request(target.id, 'start its DSH runtime', target.channel, 'delete', { path: launchFile(target.home) }).pipe(Effect.ignore)
        const process = yield* GuestEdge.start(target.id, 'start its DSH runtime', target.channel, {
          argv: ['dshfiles-sandbox-runtime'],
          cwd: target.workspace,
          env: { DSH_HOME: target.home, HOME: '/tmp' },
        })
        const stopProcess = Effect.sync(() => process.kill('SIGTERM', 5_000))
        const launch = yield* innerLaunch(target).pipe(
          Effect.retry({ schedule: Schedule.spaced(Duration.millis(250)), times: 240 }),
          Effect.tapError(() => stopProcess),
        )
        const forward = yield* LoopbackForwards.open(target.id, target.channel, launch.port).pipe(Effect.tapError(() => stopProcess))
        const published = launchFile(target.home)
        const publish = Effect.gen(function* () {
          yield* fs.makeDirectory(`${target.home}/plugins/multi-host`, { recursive: true, mode: 0o700 })
          yield* fs.writeFileString(
            published,
            `${JSON.stringify({
              schemaVersion: 1,
              launchUrl: `http://127.0.0.1:${forward.port}/?token=${launch.token}`,
              pid: globalThis.process.pid,
              writtenAt: new Date().toISOString(),
            })}\n`,
            { mode: 0o600 },
          )
        }).pipe(
          Effect.mapError(() => failed(target.id, `${published} could not be written`, 'Check that the sandboxes folder is writable, then retry.')),
          Effect.tapError(() => Effect.andThen(forward.close, stopProcess)),
        )
        yield* publish
        const started: StartedRuntime = {
          port: forward.port,
          stop: Effect.all([fs.remove(published, { force: true }).pipe(Effect.ignore), forward.close, stopProcess], { discard: true }),
        }
        return started
      })

      return SandboxRuntimes.of({ start })
    }),
  )
}
