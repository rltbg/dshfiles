/**
 * Short Host commands (the container engine's `volume`, `rm`, `version`): bounded output, a timeout that kills the
 * process, and one `<program> <verb>` client span per run with no argument values.
 */
import { Context, Duration, Effect, Layer, Stream } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'
import { SandboxStepFailed } from './errors.ts'

export interface HostCommandInput {
  readonly argv: readonly [string, ...string[]]
  readonly cwd: string
  readonly timeout?: Duration.Input
}

export interface HostCommandOutput {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

const MAX_OUTPUT_BYTES = 256 * 1024

const collect = <E>(stream: Stream.Stream<Uint8Array, E>) =>
  Stream.runFold(
    stream,
    () => ({ text: '', bytes: 0 }),
    (state, chunk) => (state.bytes >= MAX_OUTPUT_BYTES ? state : { text: state.text + new TextDecoder().decode(chunk), bytes: state.bytes + chunk.byteLength }),
  ).pipe(Effect.map(state => state.text))

export class HostCommands extends Context.Service<
  HostCommands,
  {
    /** A non-zero exit is a value, so a caller can tell "absent" from "failed". */
    readonly run: (input: HostCommandInput) => Effect.Effect<HostCommandOutput, SandboxStepFailed>
  }
>()('@dshfiles/sandboxes/HostCommands') {
  static readonly layer = Layer.effect(
    HostCommands,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const run = (input: HostCommandInput): Effect.Effect<HostCommandOutput, SandboxStepFailed> => {
        const [program, ...args] = input.argv
        const failed = (detail: string, cause?: unknown) =>
          new SandboxStepFailed({
            id: '-',
            step: `run ${program}`,
            detail,
            recovery: `Check that ${program} is installed and working (sandbox_doctor), then retry.`,
            cause,
          })
        return Effect.gen(function* () {
          const handle = yield* spawner
            .spawn(ChildProcess.make(program, args, { cwd: input.cwd, stdin: 'ignore', forceKillAfter: Duration.seconds(2), extendEnv: true }))
            .pipe(Effect.mapError(cause => failed('it could not be started', cause)))
          const [stdout, stderr, exitCode] = yield* Effect.all([collect(handle.stdout), collect(handle.stderr), handle.exitCode], {
            concurrency: 'unbounded',
          }).pipe(Effect.mapError(cause => failed('its output could not be read', cause)))
          return { exitCode, stdout, stderr }
        }).pipe(
          Effect.scoped,
          Effect.timeoutOrElse({ duration: input.timeout ?? Duration.minutes(2), orElse: () => Effect.fail(failed('it timed out')) }),
          Effect.withSpan(`${program} ${args[0] ?? 'run'}`, { kind: 'client', attributes: { 'process.command': program } }),
        )
      }
      return HostCommands.of({ run })
    }),
  )
}
