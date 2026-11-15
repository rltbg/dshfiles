import { Context, Effect, Layer } from 'effect'
import { SandboxProviderUnavailable } from './errors.ts'
import type { ProviderId, ProviderReadiness, SandboxMode, SandboxProvider } from './port.ts'
import { ContainerProvider } from './providers/container.ts'
import { DirectoryProvider } from './providers/directory.ts'
import { SandboxesSettings } from './settings.ts'

/** Every provider this plugin has, and the choice the settings make among them. */
export class SandboxProviders extends Context.Service<
  SandboxProviders,
  {
    readonly get: (id: ProviderId) => SandboxProvider
    readonly all: readonly SandboxProvider[]
    /** The provider a new sandbox uses, or why there is none. `auto` never picks the unisolated directory. */
    readonly choose: (mode: SandboxMode) => Effect.Effect<SandboxProvider, SandboxProviderUnavailable>
    readonly doctor: Effect.Effect<readonly ProviderReadiness[]>
  }
>()('@dshfiles/sandboxes/SandboxProviders') {
  static readonly layer = Layer.effect(
    SandboxProviders,
    Effect.gen(function* () {
      const settings = yield* SandboxesSettings
      const container = yield* ContainerProvider.make
      const directory = yield* DirectoryProvider.make
      const all = [container, directory]
      const get = (id: ProviderId): SandboxProvider => (id === 'container' ? container : directory)
      const choose = Effect.fn('sandbox provider choose')(function* (mode: SandboxMode) {
        const wanted = (yield* settings.get).provider
        // A runtime needs a machine of its own: only the container provider can hold one.
        const candidate = wanted === 'directory' && mode === 'workspace' ? directory : container
        const readiness = yield* candidate.describe(mode)
        if (readiness.ready) return candidate
        return yield* new SandboxProviderUnavailable({
          provider: candidate.id,
          reason: readiness.detail,
          fix: readiness.fix === undefined ? 'Run sandbox_doctor for the next step.' : `Fix: ${readiness.fix}`,
        })
      })
      const modes: readonly SandboxMode[] = ['workspace', 'runtime']
      const doctor = Effect.forEach(
        all.flatMap(provider => modes.map(mode => ({ provider, mode }))),
        entry => entry.provider.describe(entry.mode),
        { concurrency: 4 },
      )
      return SandboxProviders.of({ get, all, choose, doctor })
    }),
  )
}
