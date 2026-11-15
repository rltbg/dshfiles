import { Context, Effect, Layer } from 'effect'
import { SandboxProviderUnavailable } from './errors.ts'
import type { ProviderId, ProviderReadiness, SandboxProvider } from './port.ts'
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
    readonly choose: Effect.Effect<SandboxProvider, SandboxProviderUnavailable>
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
      const choose = Effect.gen(function* () {
        const wanted = (yield* settings.get).provider
        const candidate = wanted === 'directory' ? directory : container
        const readiness = yield* candidate.describe
        if (readiness.ready) return candidate
        return yield* new SandboxProviderUnavailable({
          provider: candidate.id,
          reason: readiness.detail,
          fix: readiness.fix === undefined ? 'Run sandbox_doctor for the next step.' : `Fix: ${readiness.fix}`,
        })
      })
      return SandboxProviders.of({ get, all, choose, doctor: Effect.forEach(all, provider => provider.describe) })
    }),
  )
}
