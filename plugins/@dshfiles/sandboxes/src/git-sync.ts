/**
 * The project goes into a sandbox as a git bundle of one commit and comes back as a git bundle of a snapshot commit.
 * A git fetch carries objects only: hooks, configuration and credentials never travel, the Host checks every object
 * (`fetch.fsckObjects`), and no hook runs on the Host while the snapshot is fetched or checked out. The user's own
 * checkout is never touched: snapshots land in a separate worktree, `<sandbox>/changes`, detached at
 * `refs/dshfiles/sandbox/<id>`.
 */
import { Git } from '@dshfiles/git-cli'
import type { GuestChannel } from '@dshfiles/sandbox-guest/channel'
import { Context, Effect, FileSystem, Layer } from 'effect'
import { SandboxProjectUnsupported, SandboxStepFailed } from './errors.ts'
import { GuestEdge } from './guest-promise.ts'
import { SandboxPaths } from './paths.ts'

const COMMIT = /^[0-9a-f]{40,64}$/u
const SNAPSHOT_REF = 'refs/dshfiles/snapshot'
/** Hooks and fsck for every git call the Host makes on objects that came from a sandbox. */
const SAFE = ['-c', 'core.hooksPath=/dev/null', '-c', 'fetch.fsckObjects=true', '-c', 'transfer.fsckObjects=true']
const IN_BUNDLE = '/tmp/dshfiles-base.bundle'
/** The snapshot commit's author, as shell words. */
const IDENTITY = "-c 'user.name=DSH sandbox' -c user.email=sandbox@dsh.invalid"
/**
 * `ctx.subprocess` drops variables whose name contains KEY from a child's environment, so `GIT_CONFIG_KEY_<n>` is
 * gone while `GIT_CONFIG_COUNT` stays, and git then refuses to start. The count is reset to match.
 */
const GIT_ENV = { GIT_CONFIG_COUNT: '0' }

export interface ProjectBase {
  readonly repoRoot: string
  readonly commit: string
}

export interface SyncResult {
  readonly commit: string
  /** `held`: the changes worktree has edits of its own, so it was left as it is; the snapshot is still fetched. */
  readonly worktree: 'updated' | 'created' | 'held'
}

export interface SandboxGitTarget {
  readonly id: string
  readonly repoRoot: string
  readonly base: string
  readonly workspace: string
  readonly channel: GuestChannel
}

export class GitSync extends Context.Service<
  GitSync,
  {
    readonly base: (path: string, revision: string | undefined) => Effect.Effect<ProjectBase, SandboxProjectUnsupported>
    readonly copyIn: (target: SandboxGitTarget) => Effect.Effect<void, SandboxStepFailed>
    readonly snapshot: (target: SandboxGitTarget) => Effect.Effect<SyncResult, SandboxStepFailed>
    /** Remove the changes worktree when it holds no edits of its own; the snapshot ref stays for the user. */
    readonly release: (id: string, repoRoot: string) => Effect.Effect<boolean, SandboxStepFailed>
  }
>()('@dshfiles/sandboxes/GitSync') {
  static readonly layer = Layer.effect(
    GitSync,
    Effect.gen(function* () {
      const git = yield* Git
      const fs = yield* FileSystem.FileSystem
      const paths = yield* SandboxPaths

      const hostGit = (id: string, step: string, cwd: string, args: readonly string[]) =>
        git.exec({ args, cwd, env: GIT_ENV }).pipe(
          Effect.mapError(
            cause =>
              new SandboxStepFailed({
                id,
                step,
                detail: cause.message,
                recovery: 'Check the project repository with git (git status, git fsck), then retry.',
                cause,
              }),
          ),
        )

      const fileFailure = (id: string, step: string) => (cause: unknown) =>
        new SandboxStepFailed({ id, step, detail: String(cause), recovery: `Check that ${paths.scratch(id)} is writable, then retry.`, cause })

      const base = Effect.fn('sandbox git base')(function* (path: string, revision: string | undefined) {
        const unsupported = (reason: string) => (cause: unknown) =>
          new SandboxProjectUnsupported({ path, reason: `${reason} (${cause instanceof Error ? cause.message : String(cause)})`, cause })
        const repoRoot = (yield* git
          .exec({ args: ['rev-parse', '--show-toplevel'], cwd: path, env: GIT_ENV })
          .pipe(Effect.mapError(unsupported('it is not in a git repository')))).trim()
        const commit = (yield* git
          .exec({ args: ['rev-parse', '--verify', '--end-of-options', `${revision ?? 'HEAD'}^{commit}`], cwd: repoRoot, env: GIT_ENV })
          .pipe(Effect.mapError(unsupported(revision === undefined ? 'the repository has no commit yet' : `${revision} is not a commit`)))).trim()
        if (!COMMIT.test(commit)) return yield* new SandboxProjectUnsupported({ path, reason: `git answered ${commit} for the base commit` })
        return { repoRoot, commit }
      })

      const copyIn = Effect.fn('sandbox git copy in')(function* (target: SandboxGitTarget) {
        const baseRef = `refs/dshfiles/sandbox-base/${target.id}`
        const bundle = `${paths.scratch(target.id)}/base.bundle`
        yield* fs.makeDirectory(paths.scratch(target.id), { recursive: true, mode: 0o700 }).pipe(Effect.mapError(fileFailure(target.id, 'copy the project in')))
        yield* hostGit(target.id, 'copy the project in', target.repoRoot, ['update-ref', baseRef, target.base])
        yield* hostGit(target.id, 'copy the project in', target.repoRoot, ['bundle', 'create', '-q', bundle, baseRef])
        const bytes = yield* fs.readFile(bundle).pipe(Effect.mapError(fileFailure(target.id, 'copy the project in')))
        const step = 'copy the project in'
        yield* GuestEdge.exec(target.id, step, target.channel, { argv: ['sh', '-c', `cat > ${IN_BUNDLE}`], cwd: target.workspace, stdin: bytes })
        yield* GuestEdge.exec(target.id, step, target.channel, {
          argv: [
            'sh',
            '-c',
            [
              'set -e',
              'git init -q -b sandbox .',
              `git fetch -q ${IN_BUNDLE} '${baseRef}:refs/dshfiles/base'`,
              `git reset -q --hard ${target.base}`,
              "git config user.name 'DSH sandbox'",
              'git config user.email sandbox@dsh.invalid',
              `rm -f ${IN_BUNDLE}`,
            ].join('\n'),
          ],
          cwd: target.workspace,
          env: GIT_ENV,
        })
        yield* fs.remove(bundle, { force: true }).pipe(Effect.ignore)
      })

      const snapshot = Effect.fn('sandbox git snapshot')(function* (target: SandboxGitTarget) {
        const step = 'copy its changes back'
        // The whole working tree, untracked files included, as one commit on a private ref, through a private index:
        // the agent's own HEAD, index and branches inside the sandbox are left as they are.
        const made = yield* GuestEdge.exec(target.id, step, target.channel, {
          argv: [
            'sh',
            '-c',
            [
              'set -e',
              'index=$(mktemp)',
              'trap \'rm -f "$index"\' EXIT',
              'export GIT_INDEX_FILE="$index"',
              'git read-tree HEAD',
              'git add -A',
              'tree=$(git write-tree)',
              `commit=$(git ${IDENTITY} commit-tree "$tree" -p HEAD -m 'DSH sandbox snapshot')`,
              `git update-ref ${SNAPSHOT_REF} "$commit"`,
              `git bundle create -q - ${SNAPSHOT_REF} ^${target.base}`,
            ].join('\n'),
          ],
          cwd: target.workspace,
          env: GIT_ENV,
          maxStdoutBytes: 512 * 1024 * 1024,
        })
        const bundle = `${paths.scratch(target.id)}/snapshot.bundle`
        yield* fs.makeDirectory(paths.scratch(target.id), { recursive: true, mode: 0o700 }).pipe(Effect.mapError(fileFailure(target.id, step)))
        yield* fs.writeFile(bundle, made.stdout, { mode: 0o600 }).pipe(Effect.mapError(fileFailure(target.id, step)))
        const ref = `refs/dshfiles/sandbox/${target.id}`
        yield* hostGit(target.id, step, target.repoRoot, [...SAFE, 'fetch', '-q', '--no-tags', '--no-write-fetch-head', bundle, `+${SNAPSHOT_REF}:${ref}`])
        yield* fs.remove(bundle, { force: true }).pipe(Effect.ignore)
        const commit = (yield* hostGit(target.id, step, target.repoRoot, ['rev-parse', '--verify', `${ref}^{commit}`])).trim()
        const changes = paths.changes(target.id)
        if (!(yield* fs.exists(changes).pipe(Effect.orElseSucceed(() => false)))) {
          yield* hostGit(target.id, step, target.repoRoot, [...SAFE, 'worktree', 'add', '-q', '--detach', changes, ref])
          return { commit, worktree: 'created' } satisfies SyncResult
        }
        const status = yield* hostGit(target.id, step, changes, ['status', '--porcelain'])
        if (status.trim() !== '') return { commit, worktree: 'held' } satisfies SyncResult
        yield* hostGit(target.id, step, changes, [...SAFE, 'checkout', '-q', '--detach', '--force', ref])
        return { commit, worktree: 'updated' } satisfies SyncResult
      })

      const release = Effect.fn('sandbox git release')(function* (id: string, repoRoot: string) {
        const changes = paths.changes(id)
        yield* hostGit(id, 'release its base', repoRoot, ['update-ref', '-d', `refs/dshfiles/sandbox-base/${id}`]).pipe(Effect.ignore)
        if (!(yield* fs.exists(changes).pipe(Effect.orElseSucceed(() => false)))) return true
        const status = yield* hostGit(id, 'release its changes worktree', changes, ['status', '--porcelain'])
        if (status.trim() !== '') return false
        yield* hostGit(id, 'release its changes worktree', repoRoot, ['worktree', 'remove', '--force', changes])
        return true
      })

      return GitSync.of({ base, copyIn, snapshot, release })
    }),
  )
}
