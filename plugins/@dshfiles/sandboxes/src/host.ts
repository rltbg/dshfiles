import { Git } from '@dshfiles/git-cli'
import { Api, DshxPlugin } from '@dshfiles/dshx/effect'
import { DshChildProcessSpawner } from '@dshfiles/dshx/effect/child-process-spawner'
import { PluginStorage } from '@dshfiles/dshx/effect/plugin-storage'
import { Settings } from '@dshfiles/dshx/effect/settings'
import { layer as nodeFileSystemLayer } from '@effect/platform-node/NodeFileSystem'
import { layer as nodePathLayer } from '@effect/platform-node/NodePath'
import { Effect, type FileSystem, Layer } from 'effect'
import { sandboxesApi } from './api.ts'
import { HostCommands } from './commands.ts'
import { GitSync } from './git-sync.ts'
import { Sandboxes } from './orchestrator.ts'
import { SandboxPaths } from './paths.ts'
import { SandboxProviders } from './providers.ts'
import { SandboxRecords } from './records.ts'
import { SandboxRuntimes } from './runtime.ts'
import { sandboxesSettings } from './settings.ts'
import { WorkspaceRegistry } from './workspace-registry-promise.ts'

const platform = Layer.mergeAll(
  DshChildProcessSpawner.layer,
  nodeFileSystemLayer,
  nodePathLayer,
  Settings.layer(sandboxesSettings),
  PluginStorage.layer,
  WorkspaceRegistry.layer,
)

/** The orchestrator over a sandboxes root; tests pass a scratch one. */
export const sandboxesLayer = (paths: Layer.Layer<SandboxPaths, never, FileSystem.FileSystem> = SandboxPaths.layer) =>
  Sandboxes.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(SandboxRecords.layer, SandboxProviders.layer, GitSync.layer, SandboxRuntimes.layer)),
    Layer.provideMerge(Layer.mergeAll(HostCommands.layer, Git.layer)),
    Layer.provideMerge(paths),
    Layer.provideMerge(platform),
  )

export default DshxPlugin.make({
  name: '@dshfiles/sandboxes',
  inject: ['subprocess', 'sandboxRoutes'],
  settings: [sandboxesSettings],
  layer: sandboxesLayer(),
  apis: [
    Api.bind(sandboxesApi, {
      list: () => Sandboxes.use(sandboxes => Effect.map(sandboxes.list, list => ({ sandboxes: list }))),
      inspect: input => Sandboxes.use(sandboxes => sandboxes.inspect(input.id)),
      logs: input => Sandboxes.use(sandboxes => sandboxes.logs(input.id)),
      doctor: () => Sandboxes.use(sandboxes => Effect.map(sandboxes.doctor, providers => ({ providers }))),
      create: input => Sandboxes.use(sandboxes => sandboxes.create(input)),
      start: input => Sandboxes.use(sandboxes => sandboxes.start(input.id)),
      stop: input => Sandboxes.use(sandboxes => sandboxes.stop(input.id)),
      export: input => Sandboxes.use(sandboxes => sandboxes.sync(input.id)),
      setRetention: input => Sandboxes.use(sandboxes => sandboxes.setRetention(input.id, input.stoppedHours)),
      destroy: input => Sandboxes.use(sandboxes => sandboxes.destroy(input.id, input.confirmDestroy)),
    }),
  ],
})
