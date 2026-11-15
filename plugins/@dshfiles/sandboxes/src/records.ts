import { PluginStorage } from '@dshfiles/dshx/effect/plugin-storage'
import { Context, Effect, Layer, Option, Schema } from 'effect'
import { SandboxNotFound, SandboxStepFailed } from './errors.ts'

export const sandboxState = Schema.Literals(['preparing', 'starting', 'ready', 'stopping', 'stopped', 'failed'])
export type SandboxState = typeof sandboxState.Type

export const sandboxRecordSchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  provider: Schema.Literals(['container', 'directory']),
  state: sandboxState,
  /** The folder the sandbox was created from, and the git repository and commit copied in. */
  projectPath: Schema.String,
  repoRoot: Schema.String,
  baseCommit: Schema.String,
  /** The folder the sandbox serves its workspace at. */
  workspace: Schema.String,
  /** The worktree on this machine where its snapshots are checked out. */
  changes: Schema.String,
  /** The DSH workspace (project) registered for the sandbox's folder, so threads can start in it. */
  workspaceId: Schema.NullOr(Schema.String),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  stoppedAt: Schema.NullOr(Schema.Number),
  /** Overrides the `stoppedHours` setting for this sandbox. */
  stoppedHours: Schema.NullOr(Schema.Number),
  lastSync: Schema.NullOr(Schema.Struct({ at: Schema.Number, commit: Schema.String, worktree: Schema.Literals(['updated', 'created', 'held']) })),
  failure: Schema.NullOr(Schema.Struct({ step: Schema.String, detail: Schema.String, recovery: Schema.String })),
})
export type SandboxRecord = typeof sandboxRecordSchema.Type

const PREFIX = 'sandbox/'
const decode = Schema.decodeUnknownEffect(sandboxRecordSchema)
const encode = Schema.encodeEffect(sandboxRecordSchema)

const storageFailure = (id: string) => (cause: unknown) =>
  new SandboxStepFailed({ id, step: 'save its record', detail: String(cause), recovery: 'Check the DSH storage (dsh --dump-config), then retry.', cause })

/** Sandbox records, one plugin-storage entry each. */
export class SandboxRecords extends Context.Service<
  SandboxRecords,
  {
    readonly list: Effect.Effect<readonly SandboxRecord[], SandboxStepFailed>
    readonly get: (id: string) => Effect.Effect<SandboxRecord, SandboxNotFound | SandboxStepFailed>
    readonly put: (record: SandboxRecord) => Effect.Effect<SandboxRecord, SandboxStepFailed>
    readonly remove: (id: string) => Effect.Effect<void, SandboxStepFailed>
  }
>()('@dshfiles/sandboxes/SandboxRecords') {
  static readonly layer = Layer.effect(
    SandboxRecords,
    Effect.gen(function* () {
      const storage = yield* PluginStorage
      const list = storage.listAll({ prefix: PREFIX }).pipe(
        Effect.mapError(storageFailure('-')),
        // A record this version cannot read is skipped rather than failing every listing.
        Effect.flatMap(entries => Effect.forEach(entries, entry => decode(entry.value).pipe(Effect.option))),
        Effect.map(decoded => decoded.flatMap(record => (Option.isSome(record) ? [record.value] : []))),
      )
      const get = (id: string) =>
        storage.get(`${PREFIX}${id}`).pipe(
          Effect.mapError(storageFailure(id)),
          Effect.flatMap((entry): Effect.Effect<SandboxRecord, SandboxNotFound | SandboxStepFailed> =>
            Option.isNone(entry) ? Effect.fail(new SandboxNotFound({ id })) : decode(entry.value.value).pipe(Effect.mapError(storageFailure(id))),
          ),
        )
      const put = (record: SandboxRecord) =>
        encode(record).pipe(
          Effect.flatMap(value => storage.set(`${PREFIX}${record.id}`, value)),
          Effect.mapError(storageFailure(record.id)),
          Effect.as(record),
        )
      const remove = (id: string) => storage.delete(`${PREFIX}${id}`).pipe(Effect.mapError(storageFailure(id)), Effect.asVoid)
      return SandboxRecords.of({ list, get, put, remove })
    }),
  )
}
