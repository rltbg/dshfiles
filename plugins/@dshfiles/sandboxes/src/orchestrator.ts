/**
 * The sandbox lifecycle: records, the provider that runs each sandbox, its route in `ctx.sandboxRoutes`, the git copy
 * in and the snapshot back, retention and reconciliation after a Host restart.
 *
 *     preparing → starting → ready → stopping → stopped → (destroyed)
 *          └──────────┴─────────┴─────────┴──────────► failed(step, recovery)
 *
 * Each sandbox's transitions run under its own lock, so two requests for one sandbox never interleave.
 */
import { randomUUID } from 'node:crypto'
import type {} from '@dshfiles/sandbox-seams/routes'
import { HostEvents } from '@dshfiles/dshx/effect'
import { hostService } from '@dshfiles/dshx/effect/host-context'
import { KeyedMutex } from '@dshfiles/dshx/effect/keyed-mutex'
import { Clock, Context, Duration, Effect, FileSystem, Layer, Option, Schedule, Stream } from 'effect'
import {
  SandboxConfirmationRequired,
  SandboxProjectUnsupported,
  SandboxProviderUnavailable,
  SandboxStateConflict,
  SandboxStepFailed,
  type SandboxNotFound,
} from './errors.ts'
import { GitSync, type SyncResult } from './git-sync.ts'
import { SandboxPaths } from './paths.ts'
import type { ProviderReadiness, SandboxSpec, StartedSandbox } from './port.ts'
import { SandboxProviders } from './providers.ts'
import { SandboxRecords, type SandboxRecord } from './records.ts'
import { SandboxRuntimes, type StartedRuntime } from './runtime.ts'
import { SandboxesSettings } from './settings.ts'
import { WorkspaceRegistry } from './workspace-registry-promise.ts'

export interface SandboxView extends SandboxRecord {
  /** A channel to the sandbox is open in this Host. */
  readonly running: boolean
}

export interface CreateInput {
  /** A folder inside the git repository to copy in. */
  readonly path: string
  /** The commit to start from; the repository's HEAD when omitted. */
  readonly base?: string | undefined
  readonly title?: string | undefined
  /** `workspace` (default): this DSH runs the agent, the sandbox its files and commands. `runtime`: a DSH runs inside. */
  readonly mode?: SandboxRecord['mode'] | undefined
}

export interface DestroyOutcome {
  readonly id: string
  /** The changes worktree had edits of its own and was kept. */
  readonly changesKept: boolean
  readonly changes: string
  readonly snapshotRef: string
}

type Failure = SandboxStepFailed | SandboxNotFound | SandboxStateConflict

interface Live {
  readonly started: StartedSandbox
  readonly unregister: () => void
}

const HOUR = 3_600_000

export class Sandboxes extends Context.Service<
  Sandboxes,
  {
    readonly list: Effect.Effect<readonly SandboxView[], SandboxStepFailed>
    readonly inspect: (id: string) => Effect.Effect<SandboxView, SandboxStepFailed | SandboxNotFound>
    readonly create: (
      input: CreateInput,
    ) => Effect.Effect<SandboxView, SandboxStepFailed | SandboxProviderUnavailable | SandboxProjectUnsupported | SandboxStateConflict>
    readonly start: (id: string) => Effect.Effect<SandboxView, Failure>
    readonly stop: (id: string) => Effect.Effect<SandboxView, Failure>
    readonly sync: (id: string) => Effect.Effect<SyncResult, Failure>
    readonly setRetention: (id: string, stoppedHours: number | null) => Effect.Effect<SandboxView, SandboxStepFailed | SandboxNotFound>
    readonly destroy: (id: string, confirmDestroy: boolean) => Effect.Effect<DestroyOutcome, Failure | SandboxConfirmationRequired>
    readonly logs: (id: string) => Effect.Effect<{ readonly running: boolean; readonly text: string }, SandboxStepFailed | SandboxNotFound>
    readonly doctor: Effect.Effect<readonly ProviderReadiness[]>
    /** Retention and reconciliation once, as the background schedule does. */
    readonly sweep: Effect.Effect<void, SandboxStepFailed>
  }
>()('@dshfiles/sandboxes/Sandboxes') {
  static readonly layer = Layer.effect(
    Sandboxes,
    Effect.gen(function* () {
      const records = yield* SandboxRecords
      const providers = yield* SandboxProviders
      const git = yield* GitSync
      const settings = yield* SandboxesSettings
      const paths = yield* SandboxPaths
      const registry = yield* WorkspaceRegistry
      const fs = yield* FileSystem.FileSystem
      const routes = yield* hostService('sandboxRoutes').pipe(Effect.orDie)
      const runtimeService = yield* SandboxRuntimes
      const live = new Map<string, Live>()
      /** The DSH runtimes running inside runtime-mode sandboxes. */
      const runtimes = new Map<string, StartedRuntime>()
      /** Sandboxes whose create is under way: their resources exist before their record says they are ready. */
      const creating = new Set<string>()
      const locks = KeyedMutex.makeUnsafe<string>()

      const view = (record: SandboxRecord): SandboxView => ({ ...record, running: live.has(record.id) })

      const specOf = Effect.fn(function* (record: Pick<SandboxRecord, 'id' | 'workspace' | 'mode'>) {
        const current = yield* settings.get
        const spec: SandboxSpec = {
          id: record.id,
          workspace: record.workspace,
          folder: paths.folder(record.id),
          image: record.mode === 'runtime' ? current.runtimeImage : current.image,
          cpus: current.cpus,
          memoryMb: current.memoryMb,
          pids: current.pids,
        }
        return spec
      })

      const save = Effect.fn(function* (record: SandboxRecord, patch: Partial<SandboxRecord>) {
        return yield* records.put({ ...record, ...patch, updatedAt: yield* Clock.currentTimeMillis })
      })

      const failWith = (record: SandboxRecord, error: SandboxStepFailed) =>
        save(record, { state: 'failed', failure: { step: error.step, detail: error.detail, recovery: error.recovery } }).pipe(
          Effect.ignore,
          Effect.andThen(Effect.fail(error)),
        )

      const requireState = (record: SandboxRecord, wanted: string, allowed: readonly SandboxRecord['state'][]) =>
        allowed.includes(record.state) ? Effect.void : Effect.fail(new SandboxStateConflict({ id: record.id, state: record.state, wanted }))

      /**
       * Start the provider's instance. In workspace mode its workspace is routed, so this DSH's tools work in it; in
       * runtime mode nothing is routed: the agent runs inside the sandbox, never here.
       */
      const launch = Effect.fn('sandbox launch')(function* (record: SandboxRecord) {
        const started = yield* providers.get(record.provider).start(yield* specOf(record))
        if (record.mode === 'runtime') {
          live.set(record.id, { started, unregister: () => undefined })
          return
        }
        const unregister = yield* Effect.try({
          try: () => routes.register({ id: record.id, root: record.workspace, channel: started.channel }),
          catch: cause =>
            new SandboxStepFailed({
              id: record.id,
              step: 'route its workspace',
              detail: String(cause),
              recovery: 'Another sandbox already serves that folder; destroy one of them, then retry.',
              cause,
            }),
        }).pipe(Effect.tapError(() => started.stop))
        live.set(record.id, { started, unregister })
      })

      /** Start the DSH runtime inside a running runtime-mode sandbox and publish its port on this machine. */
      const bootRuntime = Effect.fn('sandbox runtime boot')(function* (record: SandboxRecord) {
        const running = live.get(record.id)
        if (record.mode !== 'runtime' || running === undefined) return
        const started = yield* runtimeService.start({
          id: record.id,
          channel: running.started.channel,
          workspace: record.workspace,
          home: paths.home(record.id),
        })
        runtimes.set(record.id, started)
      })

      /** Stop the runtime inside, unroute and stop the instance, if one runs. */
      const halt = (id: string) =>
        Effect.suspend(() => {
          const runtime = runtimes.get(id)
          runtimes.delete(id)
          const running = live.get(id)
          live.delete(id)
          running?.unregister()
          return Effect.andThen(runtime?.stop ?? Effect.void, running?.started.stop ?? Effect.void)
        })

      const targetOf = (record: SandboxRecord) => {
        const running = live.get(record.id)
        if (running === undefined)
          return Effect.fail(new SandboxStateConflict({ id: record.id, state: `${record.state}, not running`, wanted: 'copy its changes back' }))
        return Effect.succeed({
          id: record.id,
          repoRoot: record.repoRoot,
          base: record.baseCommit,
          workspace: record.workspace,
          channel: running.started.channel,
        })
      }

      const syncLocked = Effect.fn('sandbox sync')(function* (record: SandboxRecord) {
        const result = yield* git.snapshot(yield* targetOf(record))
        yield* save(record, { lastSync: { at: yield* Clock.currentTimeMillis, commit: result.commit, worktree: result.worktree } })
        return result
      })

      const create = Effect.fn('sandbox create')(function* (input: CreateInput) {
        const existing = yield* records.list
        const limit = (yield* settings.get).maxSandboxes
        if (existing.length >= limit)
          return yield* new SandboxStateConflict({
            id: '-',
            state: `at the limit of ${limit} sandboxes (${existing.length} exist)`,
            wanted: 'create another; destroy one first or raise maxSandboxes',
          })
        const provider = yield* providers.choose(input.mode ?? 'workspace')
        const project = yield* git.base(input.path, input.base)
        const id = randomUUID().replaceAll('-', '').slice(0, 10)
        const now = yield* Clock.currentTimeMillis
        const title = input.title ?? `Sandbox · ${project.repoRoot.split('/').pop() ?? id}`
        let record = yield* records.put({
          id,
          title,
          provider: provider.id,
          mode: input.mode ?? 'workspace',
          state: 'preparing',
          projectPath: input.path,
          repoRoot: project.repoRoot,
          baseCommit: project.commit,
          workspace: paths.workspace(id),
          changes: paths.changes(id),
          workspaceId: null,
          createdAt: now,
          updatedAt: now,
          stoppedAt: null,
          stoppedHours: null,
          lastSync: null,
          failure: null,
        })
        creating.add(id)
        return yield* locks.withLock(id)(
          Effect.gen(function* () {
            // The anchor exists on this machine too, so DSH can register it as a project and start threads in it.
            yield* fs
              .makeDirectory(record.workspace, { recursive: true })
              .pipe(
                Effect.mapError(
                  cause =>
                    new SandboxStepFailed({ id, step: 'create', detail: String(cause), recovery: `Check that ${paths.root} is writable, then retry.`, cause }),
                ),
              )
            yield* provider.create(yield* specOf(record))
            record = yield* save(record, { state: 'starting' })
            yield* launch(record)
            yield* git.copyIn(yield* targetOf(record))
            yield* bootRuntime(record)
            // A workspace-mode sandbox is a project of this DSH; a runtime-mode one is a project of the DSH inside it,
            // and registering it here would invite a thread whose agent runs outside the sandbox.
            const workspace = record.mode === 'workspace' ? yield* registry.create(record.workspace, title).pipe(Effect.option) : Option.none()
            record = yield* save(record, { state: 'ready', workspaceId: workspace._tag === 'Some' ? workspace.value.id : null })
            return view(record)
          }).pipe(
            Effect.catchTag('SandboxStepFailed', error => halt(id).pipe(Effect.andThen(failWith(record, error)))),
            Effect.catchTag('SandboxStateConflict', error => halt(id).pipe(Effect.andThen(Effect.fail(error)))),
            Effect.ensuring(Effect.sync(() => creating.delete(id))),
          ),
        )
      })

      const start = Effect.fn('sandbox start')(function* (id: string) {
        return yield* locks.withLock(id)(
          Effect.gen(function* () {
            let record = yield* records.get(id)
            if (live.has(id)) return yield* new SandboxStateConflict({ id, state: 'running', wanted: 'start' })
            yield* requireState(record, 'start', ['stopped', 'failed'])
            record = yield* save(record, { state: 'starting', failure: null })
            yield* Effect.andThen(launch(record), bootRuntime(record)).pipe(
              Effect.catchTag('SandboxStepFailed', error => halt(id).pipe(Effect.andThen(failWith(record, error)))),
            )
            record = yield* save(record, { state: 'ready', stoppedAt: null })
            return view(record)
          }),
        )
      })

      /** Copy the changes back when the settings ask for it, then stop; a failed copy is recorded, not fatal. */
      const stopLocked = Effect.fn('sandbox stop')(function* (record: SandboxRecord) {
        let current = yield* save(record, { state: 'stopping' })
        if ((yield* settings.get).syncAfterTurn && live.has(record.id)) {
          const synced = yield* syncLocked(current).pipe(Effect.option)
          current = yield* records.get(record.id).pipe(Effect.orElseSucceed(() => current))
          if (synced._tag === 'None')
            current = {
              ...current,
              failure: {
                step: 'copy its changes back at stop',
                detail: 'the last snapshot failed',
                recovery: 'Start the sandbox and export it (sandbox_export) before destroying it.',
              },
            }
        }
        yield* halt(record.id)
        return yield* save(current, { state: 'stopped', stoppedAt: yield* Clock.currentTimeMillis })
      })

      const destroyLocked = Effect.fn('sandbox destroy')(function* (record: SandboxRecord) {
        if (live.has(record.id)) yield* stopLocked(record)
        yield* providers.get(record.provider).destroy(yield* specOf(record))
        const released = yield* git.release(record.id, record.repoRoot).pipe(Effect.orElseSucceed(() => false))
        if (record.workspaceId !== null) yield* registry.delete(record.workspaceId).pipe(Effect.ignore)
        yield* fs.remove(record.workspace, { recursive: true, force: true }).pipe(Effect.ignore)
        yield* fs.remove(paths.scratch(record.id), { recursive: true, force: true }).pipe(Effect.ignore)
        yield* records.remove(record.id)
        const outcome: DestroyOutcome = { id: record.id, changesKept: !released, changes: record.changes, snapshotRef: `refs/dshfiles/sandbox/${record.id}` }
        return outcome
      })

      const stop = Effect.fn('sandbox stop request')(function* (id: string) {
        const outcome = yield* locks.withLock(id)(
          Effect.gen(function* () {
            const record = yield* records.get(id)
            yield* requireState(record, 'stop', ['ready', 'starting', 'failed'])
            return yield* stopLocked(record)
          }),
        )
        const hours = outcome.stoppedHours ?? (yield* settings.get).stoppedHours
        if (hours === 0) yield* locks.withLock(id)(destroyLocked(outcome)).pipe(Effect.ignore)
        return view(outcome)
      })

      const destroy = Effect.fn('sandbox destroy request')(function* (id: string, confirmDestroy: boolean) {
        if (!confirmDestroy)
          return yield* new SandboxConfirmationRequired({
            id,
            reason: 'deletes its files and its processes; changes not yet copied back are lost, and the copied ones stay in its changes worktree',
          })
        return yield* locks.withLock(id)(Effect.flatMap(records.get(id), destroyLocked))
      })

      const sync = (id: string) => locks.withLock(id)(Effect.flatMap(records.get(id), syncLocked))

      const setRetention = Effect.fn('sandbox set retention')(function* (id: string, stoppedHours: number | null) {
        return view(yield* locks.withLock(id)(Effect.flatMap(records.get(id), record => save(record, { stoppedHours }))))
      })

      const logs = Effect.fn('sandbox logs')(function* (id: string) {
        yield* records.get(id)
        const running = live.get(id)
        if (running === undefined) return { running: false, text: '' }
        return { running: true, text: yield* running.started.logs }
      })

      /** After a Host restart no channel is open: what was running is stopped now, and orphans are removed. */
      const reconcile = Effect.fn('sandbox reconcile')(function* () {
        const known = yield* records.list
        for (const record of known) {
          if (live.has(record.id) || record.state === 'stopped' || record.state === 'failed') continue
          yield* locks.withLock(record.id)(
            record.state === 'preparing'
              ? save(record, {
                  state: 'failed',
                  failure: { step: 'create', detail: 'DSH stopped while it was being created', recovery: 'Destroy it and create a new one.' },
                })
              : save(record, { state: 'stopped', stoppedAt: yield* Clock.currentTimeMillis }),
          )
        }
        // Resources first, records after: a sandbox created in between has its record by then, and one still being
        // created is skipped, so a new sandbox is never taken for an orphan.
        for (const provider of providers.all) {
          const held = yield* provider.list.pipe(Effect.orElseSucceed(() => []))
          const ids = new Set((yield* records.list).map(record => record.id))
          for (const id of held) {
            if (ids.has(id) || creating.has(id)) continue
            yield* provider.destroy(yield* specOf({ id, workspace: paths.workspace(id), mode: 'workspace' })).pipe(Effect.ignore)
          }
        }
      })

      const retention = Effect.fn('sandbox retention')(function* () {
        const now = yield* Clock.currentTimeMillis
        const defaultHours = (yield* settings.get).stoppedHours
        for (const record of yield* records.list) {
          if (record.state !== 'stopped' || record.stoppedAt === null || live.has(record.id)) continue
          if (now - record.stoppedAt < (record.stoppedHours ?? defaultHours) * HOUR) continue
          yield* locks.withLock(record.id)(destroyLocked(record)).pipe(Effect.ignore)
        }
      })

      const sweep = Effect.andThen(reconcile(), retention())

      yield* sweep.pipe(Effect.ignore, Effect.repeat(Schedule.spaced(Duration.minutes(10))), Effect.forkScoped)

      // After every agent turn in a sandbox, copy its changes back.
      yield* HostEvents.stream('agent/status').pipe(
        Stream.runForEach(([payload]) =>
          Effect.gen(function* () {
            if (payload.status !== 'idle' || !(yield* settings.get).syncAfterTurn) return
            const cwd = payload.agent.session.header.cwd
            if (cwd === undefined) return
            const route = routes.forPath(cwd)
            if (route === undefined || !live.has(route.id)) return
            yield* sync(route.id).pipe(Effect.ignore, Effect.forkDetach)
          }),
        ),
        Effect.forkScoped,
      )

      // When the plugin stops, every open sandbox stops with it; its workspace stays for a later start.
      yield* Effect.addFinalizer(() =>
        Effect.forEach(
          [...live.keys()],
          id =>
            records.get(id).pipe(
              Effect.flatMap(record => stopLocked(record)),
              Effect.ignore,
            ),
          { discard: true },
        ),
      )

      return Sandboxes.of({
        list: Effect.map(records.list, known => known.map(view)),
        inspect: id => Effect.map(records.get(id), view),
        create,
        start,
        stop,
        sync,
        setRetention,
        destroy,
        logs,
        doctor: providers.doctor,
        sweep,
      })
    }),
  )
}
