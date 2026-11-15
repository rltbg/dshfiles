/**
 * The wire format between the user's DSH and the guest agent in a sandbox. One JSON object per line, in both
 * directions, over the sandbox's stdin and stdout. Binary payloads are base64. The guest agent restates these
 * shapes by hand because it must stay a single file with no imports beyond Node builtins; `guest-agent.test.ts`
 * keeps the two in step.
 */

/** Bumped on any incompatible change; the host refuses a guest agent that announces another version. */
export const PROTOCOL_VERSION = 1

export interface GuestHello {
  readonly t: 'hello'
  readonly v: number
  readonly uid: number
  readonly pid: number
  readonly platform: string
  readonly root: string
  readonly confine: boolean
}

/** Error codes the guest agent returns. The `FS_*` codes are the ones `@deepseek-ai/dsh-fs` defines. */
export type GuestErrorCode =
  | 'FS_NOT_FOUND'
  | 'FS_NOT_DIRECTORY'
  | 'FS_NOT_REGULAR_FILE'
  | 'FS_TOO_LARGE'
  | 'FS_PERMISSION_DENIED'
  | 'FS_SANDBOX_DENIED'
  | 'FS_IO_ERROR'
  | 'FS_STALE_VERSION'
  | 'FS_ALREADY_EXISTS'
  | 'GUEST_BAD_REQUEST'
  | 'GUEST_SPAWN_FAILED'
  | 'GUEST_NO_PROCESS'

export type GuestEntryType = 'file' | 'directory' | 'symlink' | 'other'

export interface GuestStat {
  readonly type: GuestEntryType
  readonly size: number
  /** `dev:ino:size:mtimeNs:ctimeNs`, the same shape the local filesystem uses for its version token. */
  readonly version: string
}

export interface GuestDirEntry extends GuestStat {
  readonly name: string
}

export type GuestWriteIntent = { readonly kind: 'any' } | { readonly kind: 'createIfAbsent' } | { readonly kind: 'replaceIfVersion'; readonly version: string }

/** Requests the host sends, keyed by operation, with their results. */
export interface GuestOperations {
  readonly ping: { readonly args: Record<string, never>; readonly result: Record<string, never> }
  readonly realpath: { readonly args: { readonly path: string }; readonly result: { readonly path: string } }
  /** `follow: false` describes a symlink itself instead of its target. A missing path answers `null`. */
  readonly stat: { readonly args: { readonly path: string; readonly follow: boolean }; readonly result: GuestStat | null }
  readonly list: { readonly args: { readonly path: string }; readonly result: { readonly entries: readonly GuestDirEntry[] } }
  /** Reads a regular file. `max` refuses a larger file with `FS_TOO_LARGE`; `offset`/`length` read a window. */
  readonly read: {
    readonly args: { readonly path: string; readonly max?: number; readonly offset?: number; readonly length?: number }
    readonly result: { readonly data: string; readonly size: number; readonly version: string }
  }
  /** Writes atomically (temporary file, then rename), creating parent directories. */
  readonly write: {
    readonly args: { readonly path: string; readonly data: string; readonly intent: GuestWriteIntent }
    readonly result: { readonly version: string; readonly created: boolean }
  }
  readonly delete: { readonly args: { readonly path: string; readonly version?: string }; readonly result: Record<string, never> }
  readonly rename: { readonly args: { readonly from: string; readonly to: string }; readonly result: Record<string, never> }
  /** Resolves a command name on the guest's `PATH`; `null` when absent. */
  readonly which: { readonly args: { readonly command: string }; readonly result: { readonly path: string | null } }
  /** Starts a process in its own process group. Output and exit arrive as `out` and `exit` messages for `p`. */
  readonly spawn: {
    readonly args: { readonly argv: readonly string[]; readonly cwd: string; readonly env?: Readonly<Record<string, string>> }
    readonly result: { readonly p: number }
  }
  /** Signals a process group started by `spawn`. */
  readonly kill: { readonly args: { readonly p: number; readonly signal: string }; readonly result: Record<string, never> }
}

export type GuestOperation = keyof GuestOperations

export type HostToGuest =
  | { readonly t: 'req'; readonly id: number; readonly op: GuestOperation; readonly a: unknown }
  | { readonly t: 'in'; readonly p: number; readonly d: string }
  | { readonly t: 'in-end'; readonly p: number }

export type GuestToHost =
  | GuestHello
  | { readonly t: 'res'; readonly id: number; readonly ok: true; readonly r: GuestOperations[GuestOperation]['result'] }
  | { readonly t: 'res'; readonly id: number; readonly ok: false; readonly e: { readonly code: GuestErrorCode; readonly message: string } }
  | { readonly t: 'out'; readonly p: number; readonly f: 1 | 2; readonly d: string }
  | { readonly t: 'exit'; readonly p: number; readonly code: number | null; readonly signal: string | null }
