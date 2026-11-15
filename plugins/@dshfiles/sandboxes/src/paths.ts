import { fileURLToPath } from 'node:url'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { Context, Effect, FileSystem, Layer } from 'effect'
import { SandboxStepFailed } from './errors.ts'

/** Where sandboxes live on this machine, and the guest agent's source. */
export class SandboxPaths extends Context.Service<
  SandboxPaths,
  {
    readonly root: string
    /** The folder a sandbox serves its workspace at; on this machine it stays an empty anchor for a container. */
    readonly workspace: (id: string) => string
    /** A sandbox's own folder: its workspace, and in runtime mode the DSH home of the runtime inside. */
    readonly folder: (id: string) => string
    /** The DSH home of a runtime-mode sandbox, at the same path inside the sandbox and on this machine. */
    readonly home: (id: string) => string
    /** The git worktree on this machine where a sandbox's snapshots are checked out. */
    readonly changes: (id: string) => string
    /** A private folder for one sandbox's transfer files (bundles). */
    readonly scratch: (id: string) => string
    /** The guest agent's source, read once. */
    readonly agentSource: Effect.Effect<string, SandboxStepFailed>
  }
>()('@dshfiles/sandboxes/SandboxPaths') {
  static readonly layerAt = (root: string) =>
    Layer.effect(
      SandboxPaths,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        // Engine commands run from this folder, so it must exist before the first sandbox does.
        yield* fs.makeDirectory(root, { recursive: true, mode: 0o700 }).pipe(Effect.ignore)
        const agentFile = fileURLToPath(import.meta.resolve('@dshfiles/sandbox-guest/agent'))
        const agentSource = yield* Effect.cached(
          fs.readFileString(agentFile).pipe(
            Effect.mapError(
              cause =>
                new SandboxStepFailed({
                  id: '-',
                  step: 'read the guest agent',
                  detail: `${agentFile} could not be read`,
                  recovery: 'Rebuild the plugin (pnpm --dir plugins/@dshfiles/sandbox-guest build), then retry.',
                  cause,
                }),
            ),
          ),
        )
        return SandboxPaths.of({
          root,
          workspace: id => `${root}/${id}/workspace`,
          folder: id => `${root}/${id}`,
          home: id => `${root}/${id}/home`,
          changes: id => `${root}/${id}/changes`,
          scratch: id => `${root}/${id}/transfer`,
          agentSource,
        })
      }),
    )

  static readonly layer = Layer.suspend(() => SandboxPaths.layerAt(dshHomePath('sandboxes')))
}
