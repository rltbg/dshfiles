/**
 * Sandboxes in Docker or Podman containers. A sandbox is a named volume (its workspace, kept between starts) and,
 * while it runs, one container started with `run -i`: the guest agent is its first process and its stdin and stdout
 * are the channel, so there is no published port, no mounted socket and no `exec` per call. The container is
 * hardened: no capabilities, no new privileges, a read-only root, no network, a non-root user and resource limits.
 */
import { Duration, Effect } from 'effect'
import { HostCommands } from '../commands.ts'
import { hostService } from '@dshfiles/dshx/effect/host-context'
import { SandboxStepFailed } from '../errors.ts'
import { GuestEdge } from '../guest-promise.ts'
import { SandboxPaths } from '../paths.ts'
import type { ProviderReadiness, SandboxProvider, SandboxSpec, StartedSandbox } from '../port.ts'
import { SandboxesSettings } from '../settings.ts'

const LABEL = 'dshfiles.sandbox'
const USER = '1000:1000'

const volumeOf = (id: string): string => `dshfiles-sandbox-${id}`
const containerOf = (id: string): string => `dshfiles-sandbox-${id}`

export const BUILD_IMAGE_HINT = 'docker build -t dshfiles-sandbox:1 plugins/@dshfiles/sandboxes/image'

export class ContainerProvider {
  static readonly make = Effect.gen(function* () {
    const commands = yield* HostCommands
    const settings = yield* SandboxesSettings
    const paths = yield* SandboxPaths
    const subprocess = yield* hostService('subprocess').pipe(Effect.orDie)

    /** The engine to use: the configured one, else Podman when it answers, else Docker. */
    const engine = Effect.gen(function* () {
      const configured = (yield* settings.get).containerEngine
      const candidates = configured === 'auto' ? (['podman', 'docker'] as const) : ([configured] as const)
      for (const candidate of candidates) {
        const probe = yield* commands
          .run({ argv: [candidate, 'version', '--format', '{{.Server.Version}}'], cwd: paths.root, timeout: Duration.seconds(10) })
          .pipe(Effect.option)
        if (probe._tag === 'Some' && probe.value.exitCode === 0) return candidate
      }
      return undefined
    })

    const failed = (spec: SandboxSpec, step: string, detail: string, recovery: string) => new SandboxStepFailed({ id: spec.id, step, detail, recovery })

    const engineOrFail = (spec: SandboxSpec, step: string) =>
      Effect.flatMap(engine, found =>
        found === undefined
          ? Effect.fail(failed(spec, step, 'neither Podman nor Docker answers', 'Install Podman (recommended, rootless) or Docker and start it, then retry.'))
          : Effect.succeed(found),
      )

    const checked = Effect.fn('sandbox container command')(function* (spec: SandboxSpec, step: string, argv: readonly [string, ...string[]]) {
      const output = yield* commands.run({ argv, cwd: paths.root })
      if (output.exitCode !== 0) return yield* failed(spec, step, output.stderr.trim().slice(-400), 'Read the engine message above, fix it, then retry.')
      return output
    })

    const describe: Effect.Effect<ProviderReadiness> = Effect.gen(function* () {
      const found = yield* engine
      if (found === undefined)
        return {
          provider: 'container',
          ready: false,
          isolation: 'container',
          detail: 'Neither Podman nor Docker answers on this machine.',
          fix: 'Install Podman (recommended, rootless) or Docker and start it.',
        } satisfies ProviderReadiness
      const image = (yield* settings.get).image
      const inspected = yield* commands.run({ argv: [found, 'image', 'inspect', image], cwd: paths.root }).pipe(Effect.option)
      if (inspected._tag === 'None' || inspected.value.exitCode !== 0)
        return {
          provider: 'container',
          ready: false,
          isolation: 'container',
          detail: `${found} answers, but the image ${image} is not on this machine.`,
          fix: image === 'dshfiles-sandbox:1' ? BUILD_IMAGE_HINT.replace('docker', found) : `${found} pull ${image}`,
        } satisfies ProviderReadiness
      return { provider: 'container', ready: true, isolation: 'container', detail: `${found} with the image ${image}.` } satisfies ProviderReadiness
    })

    const create = Effect.fn('sandbox container create')(function* (spec: SandboxSpec) {
      const found = yield* engineOrFail(spec, 'create')
      yield* checked(spec, 'create', [found, 'volume', 'create', '--label', `${LABEL}=${spec.id}`, volumeOf(spec.id)])
      // A new volume belongs to root; the sandbox user must own its workspace. This one short root container runs with
      // no network and no capability but CHOWN, once per sandbox.
      yield* checked(spec, 'create', [
        found,
        'run',
        '--rm',
        '--network',
        'none',
        '--cap-drop',
        'ALL',
        '--cap-add',
        'CHOWN',
        '--user',
        '0:0',
        '--mount',
        `type=volume,src=${volumeOf(spec.id)},dst=/workspace`,
        spec.image,
        'chown',
        USER,
        '/workspace',
      ])
    })

    const start = Effect.fn('sandbox container start')(function* (spec: SandboxSpec) {
      const found = yield* engineOrFail(spec, 'start')
      const source = yield* paths.agentSource
      // A container of an earlier run that is still there (the Host died before it ended) would hold the name.
      yield* commands.run({ argv: [found, 'rm', '-f', containerOf(spec.id)], cwd: paths.root }).pipe(Effect.ignore)
      const argv = [
        found,
        'run',
        '-i',
        '--rm',
        '--name',
        containerOf(spec.id),
        '--label',
        `${LABEL}=${spec.id}`,
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges',
        '--read-only',
        '--network',
        'none',
        '--pids-limit',
        String(spec.pids),
        '--memory',
        `${spec.memoryMb}m`,
        '--cpus',
        String(spec.cpus),
        '--user',
        USER,
        '--tmpfs',
        '/tmp:size=512m,mode=1777',
        // `volume-nocopy`: the engine would otherwise copy the ownership of the image's (root's) mount point onto the
        // empty volume, and the sandbox user could not write its own workspace.
        '--mount',
        `type=volume,src=${volumeOf(spec.id)},dst=${spec.workspace},volume-nocopy`,
        '--workdir',
        spec.workspace,
        '--env',
        'HOME=/tmp',
        spec.image,
        'node',
        '--input-type=module',
        '-e',
        source,
        '--',
        '--root',
        spec.workspace,
      ]
      const process = yield* GuestEdge.spawn(spec.id, subprocess, {
        argv,
        cwd: paths.root,
        stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 64_000 } },
        graceMs: 5_000,
      })
      yield* GuestEdge.hello(spec.id, process, Duration.seconds(60)).pipe(
        Effect.tapError(() => GuestEdge.close(process)),
        Effect.mapError(error => {
          const reason = process.handle.collected.stderr?.readFrom(0).text.trim().slice(-400) ?? ''
          return reason === '' ? error : failed(spec, 'start', reason, error.recovery)
        }),
      )
      const started: StartedSandbox = { channel: process.channel, logs: GuestEdge.stderr(process), stop: GuestEdge.close(process) }
      return started
    })

    const destroy = Effect.fn('sandbox container destroy')(function* (spec: SandboxSpec) {
      const found = yield* engineOrFail(spec, 'destroy')
      yield* commands.run({ argv: [found, 'rm', '-f', containerOf(spec.id)], cwd: paths.root }).pipe(Effect.ignore)
      const removed = yield* commands.run({ argv: [found, 'volume', 'rm', '-f', volumeOf(spec.id)], cwd: paths.root })
      if (removed.exitCode !== 0 && !/no such volume/iu.test(removed.stderr))
        return yield* failed(spec, 'destroy', removed.stderr.trim().slice(-400), 'Remove the volume with the engine, then destroy the sandbox again.')
    })

    const list = Effect.gen(function* () {
      const found = yield* engine
      if (found === undefined) return []
      const listed = yield* commands.run({ argv: [found, 'volume', 'ls', '--filter', `label=${LABEL}`, '--format', '{{.Name}}'], cwd: paths.root })
      if (listed.exitCode !== 0) return []
      return listed.stdout
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.startsWith('dshfiles-sandbox-'))
        .map(line => line.slice('dshfiles-sandbox-'.length))
    })

    const provider: SandboxProvider = { id: 'container', describe, create, start, destroy, list }
    return provider
  })
}
