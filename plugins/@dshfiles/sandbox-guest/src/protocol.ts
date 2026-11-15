/**
 * The wire format between the user's DSH and the guest agent in a sandbox. One JSON object per line, in both
 * directions, over the sandbox's stdin and stdout. Binary payloads are base64.
 *
 * The host decodes everything the guest sends with the schemas below. The guest agent restates the request shapes
 * by hand, because it must stay a single file with no imports beyond Node builtins; `guest-agent.test.ts` runs the
 * real agent through every operation, which keeps the two in step.
 */
import { Schema } from 'effect'

/** Bumped on any incompatible change; the host refuses a guest agent that announces another version. */
export const PROTOCOL_VERSION = 1

const entryType = Schema.Literals(['file', 'directory', 'symlink', 'other'])

const statSchema = Schema.Struct({
  type: entryType,
  size: Schema.Number,
  /** `dev:ino:size:mtimeNs:ctimeNs`, the same shape the local filesystem uses for its version token. */
  version: Schema.String,
})

const empty = Schema.Struct({})

/** The result schema of each operation the host may request. */
export const resultSchemas = {
  ping: empty,
  realpath: Schema.Struct({ path: Schema.String }),
  /** A missing path answers `null`; `follow: false` describes a symlink itself. */
  stat: Schema.NullOr(statSchema),
  list: Schema.Struct({ entries: Schema.Array(Schema.Struct({ name: Schema.String, ...statSchema.fields })) }),
  /** A regular file, whole or a window; base64 data. */
  read: Schema.Struct({ data: Schema.String, size: Schema.Number, version: Schema.String }),
  /** Written atomically (temporary file, then rename), creating parent directories. */
  write: Schema.Struct({ version: Schema.String, created: Schema.Boolean }),
  delete: empty,
  rename: empty,
  /** A command name resolved on the guest's `PATH`; `null` when absent. */
  which: Schema.Struct({ path: Schema.NullOr(Schema.String) }),
  /** A process started in its own process group; output and exit arrive as `out` and `exit` messages for `p`. */
  spawn: Schema.Struct({ p: Schema.Number }),
  /** Signals a process group started by `spawn`. */
  kill: empty,
}

export type GuestOperation = keyof typeof resultSchemas

export type GuestWriteIntent = { readonly kind: 'any' } | { readonly kind: 'createIfAbsent' } | { readonly kind: 'replaceIfVersion'; readonly version: string }

/** The arguments of each operation. */
export interface GuestArguments {
  readonly ping: Record<string, never>
  readonly realpath: { readonly path: string }
  readonly stat: { readonly path: string; readonly follow: boolean }
  readonly list: { readonly path: string }
  /** `max` refuses a larger file with `FS_TOO_LARGE`; `offset` and `length` read a window. */
  readonly read: { readonly path: string; readonly max?: number; readonly offset?: number; readonly length?: number }
  readonly write: { readonly path: string; readonly data: string; readonly intent: GuestWriteIntent }
  readonly delete: { readonly path: string; readonly version?: string }
  readonly rename: { readonly from: string; readonly to: string }
  readonly which: { readonly command: string }
  readonly spawn: { readonly argv: readonly string[]; readonly cwd: string; readonly env?: Readonly<Record<string, string>> }
  readonly kill: { readonly p: number; readonly signal: string }
}

export type GuestResult<K extends GuestOperation> = (typeof resultSchemas)[K]['Type']
export type GuestStat = typeof statSchema.Type
export type GuestDirEntry = GuestResult<'list'>['entries'][number]

/** Error codes the guest agent returns. The `FS_*` codes are the ones `@deepseek-ai/dsh-fs` defines. */
export const guestErrorCode = Schema.Literals([
  'FS_NOT_FOUND',
  'FS_NOT_DIRECTORY',
  'FS_NOT_REGULAR_FILE',
  'FS_TOO_LARGE',
  'FS_PERMISSION_DENIED',
  'FS_SANDBOX_DENIED',
  'FS_IO_ERROR',
  'FS_STALE_VERSION',
  'FS_ALREADY_EXISTS',
  'GUEST_BAD_REQUEST',
  'GUEST_SPAWN_FAILED',
  'GUEST_NO_PROCESS',
])
export type GuestErrorCode = typeof guestErrorCode.Type

export const helloSchema = Schema.Struct({
  t: Schema.Literal('hello'),
  v: Schema.Number,
  uid: Schema.Number,
  pid: Schema.Number,
  platform: Schema.String,
  root: Schema.String,
  confine: Schema.Boolean,
})
export type GuestHello = typeof helloSchema.Type

const signalName = Schema.Literals([
  'SIGTERM',
  'SIGKILL',
  'SIGINT',
  'SIGHUP',
  'SIGQUIT',
  'SIGTSTP',
  'SIGCONT',
  'SIGUSR1',
  'SIGUSR2',
  'SIGPIPE',
  'SIGABRT',
  'SIGSEGV',
  'SIGBUS',
  'SIGFPE',
  'SIGILL',
  'SIGALRM',
  'SIGTRAP',
  'SIGSYS',
])

/** Everything the guest agent writes on its stdout. A response's `r` is decoded again with the operation's schema. */
export const guestMessageSchema = Schema.Union([
  helloSchema,
  Schema.Struct({ t: Schema.Literal('res'), id: Schema.Number, ok: Schema.Literal(true), r: Schema.Unknown }),
  Schema.Struct({
    t: Schema.Literal('res'),
    id: Schema.Number,
    ok: Schema.Literal(false),
    e: Schema.Struct({ code: guestErrorCode, message: Schema.String }),
  }),
  Schema.Struct({ t: Schema.Literal('out'), p: Schema.Number, f: Schema.Literals([1, 2]), d: Schema.String }),
  Schema.Struct({ t: Schema.Literal('exit'), p: Schema.Number, code: Schema.NullOr(Schema.Number), signal: Schema.NullOr(signalName) }),
])

export type HostToGuest =
  | { readonly t: 'req'; readonly id: number; readonly op: GuestOperation; readonly a: GuestArguments[GuestOperation] }
  | { readonly t: 'in'; readonly p: number; readonly d: string }
  | { readonly t: 'in-end'; readonly p: number }
