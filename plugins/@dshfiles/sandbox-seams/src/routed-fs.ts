/**
 * `ctx.fs` for threads that run in a sandbox. It extends the stock `SandboxedFileSystem` and calls it unchanged for
 * any path no sandbox routes, so a thread without a sandbox sees the stock behaviour. A path inside a sandbox's
 * workspace goes to that sandbox's guest agent instead.
 *
 * Text semantics follow `@deepseek-ai/dsh-fs-local` 0.2.2-rc.2 (MIT): realpath identity through the nearest existing
 * ancestor, line endings kept on edit, a NUL byte in the first 8 KiB meaning binary, and the same error codes for the
 * same refusals. Every edit computes the new content here and writes it back with the version it read, so a
 * concurrent change inside the sandbox fails as stale instead of being overwritten.
 */
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { FS_ERROR_CODES, FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type {
  FsDeleteOutcome,
  FsDirEntry,
  FsEditOutcome,
  FsEditRequest,
  FsErrorCode,
  FsInfo,
  FsMoveOutcome,
  FsPathInfo,
  FsTarget,
  FsWriteIntent,
  FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import { applyHunks, type PatchHunk } from '@deepseek-ai/dsh-fs-patch'
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import { GuestError } from '@dshfiles/sandbox-guest/channel'
import type { GuestStat, GuestWriteIntent } from '@dshfiles/sandbox-guest/protocol'
import { RoutePaths, type SandboxRoute } from './routes.ts'

const KEY_PREFIX = 'sandbox:'
const BINARY_SAMPLE_BYTES = 8192

/** A target inside a sandbox: the route that serves it and its physical path there. */
interface RoutedTarget {
  readonly route: SandboxRoute
  readonly path: string
}

/** Target keys of routed files: `sandbox:<id>:<physical path>`, never a path a local provider could open. */
export class RoutedTargetKeys {
  static of(id: string, path: string): FsTargetKey {
    return FsTargetKey(`${KEY_PREFIX}${id}:${path}`)
  }

  /** The sandbox id and path of a routed key, or `undefined` for a local key. */
  static parse(key: string): { readonly id: string; readonly path: string } | undefined {
    if (!key.startsWith(KEY_PREFIX)) return undefined
    const separator = key.indexOf(':', KEY_PREFIX.length)
    if (separator < 0) return undefined
    return { id: key.slice(KEY_PREFIX.length, separator), path: key.slice(separator + 1) }
  }
}

/** Text helpers with the local provider's semantics. */
class Text {
  static normalize(content: string): string {
    return content.replaceAll('\r\n', '\n')
  }

  static lineEndings(raw: string): 'CRLF' | 'LF' {
    const sample = raw.slice(0, 4096)
    const crlf = sample.split('\r\n').length - 1
    return crlf > sample.split('\n').length - 1 - crlf ? 'CRLF' : 'LF'
  }

  static restore(content: string, lineEndings: 'CRLF' | 'LF'): string {
    return lineEndings === 'LF' ? content : Text.normalize(content).split('\n').join('\r\n')
  }

  static decode(bytes: Uint8Array, verb: string, displayPath: string): string {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch (error) {
      if (!(error instanceof TypeError)) throw error
      throw new FsError(`cannot ${verb} "${displayPath}": invalid UTF-8 text`, 'FS_NOT_TEXT')
    }
  }

  static occurrences(content: string, needle: string): number {
    let count = 0
    let index = content.indexOf(needle)
    while (index !== -1) {
      count += 1
      index = content.indexOf(needle, index + needle.length)
    }
    return count
  }

  static literalEdit(content: string, edit: FsEditRequest, displayPath: string): string {
    const oldText = Text.normalize(edit.oldString)
    if (oldText.length === 0) throw new FsError('old_string must be a non-empty string', 'FS_EDIT_NOT_FOUND')
    const count = Text.occurrences(content, oldText)
    if (count === 0) throw new FsError(`old_string was not found in "${displayPath}"`, 'FS_EDIT_NOT_FOUND')
    if (!edit.replaceAll && count > 1)
      throw new FsError(
        `old_string matched ${count} times in "${displayPath}"; provide a more specific old_string or set replace_all to true`,
        'FS_AMBIGUOUS_EDIT',
      )
    return content.split(oldText).join(Text.normalize(edit.newString))
  }
}

const isFsErrorCode = (code: string): code is FsErrorCode => FS_ERROR_CODES.some(known => known === code)

/** A guest failure as the `FsError` the tools expect, with a way forward when the sandbox itself is gone. */
const asFsError = (error: unknown, route: SandboxRoute): Error => {
  if (!(error instanceof GuestError)) return error instanceof Error ? error : new Error(String(error))
  if (isFsErrorCode(error.code)) return new FsError(error.message, error.code, { cause: error })
  if (error.code === 'GUEST_CLOSED')
    return new FsError(
      `sandbox ${route.id} is no longer reachable: ${error.message}. Start it again from the Sandboxes page (or the sandbox_start tool), then retry.`,
      'FS_IO_ERROR',
      { cause: error },
    )
  return new FsError(`sandbox ${route.id}: ${error.message}`, 'FS_IO_ERROR', { cause: error })
}

const throwIfAborted = (signal: AbortSignal | undefined, verb: string): void => {
  if (signal?.aborted === true) throw new FsError(`${verb} aborted`, 'FS_ABORTED')
}

const infoType = (type: GuestStat['type']): FsInfo['type'] => (type === 'symlink' ? 'other' : type)

export class RoutedFileSystem extends SandboxedFileSystem {
  static override inject = ['sandboxPolicy', 'sandboxRoutes']

  /** Per routed target: the tail of its mutation queue, so one target's edits never interleave. */
  private readonly routedLocks = new Map<string, Promise<void>>()

  override async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    throwIfAborted(opts?.signal, 'resolve')
    const routes = this.ctx.sandboxRoutes
    const cwd = opts?.cwd ?? this.config.cwd
    const asking = opts?.cwd === undefined ? undefined : routes.forPath(opts.cwd)
    if (asking !== undefined && (path === '~' || path.startsWith('~/')))
      throw new FsError(`"${path}" is the Host's home folder, outside sandbox ${asking.id}; use a path inside ${asking.root}`, 'FS_SANDBOX_DENIED')
    if (path.trim().length === 0) return super.resolve(path, opts)
    const absolute = RoutePaths.absolute(path, cwd)
    const owner = routes.forPath(absolute)
    if (opts?.cwd !== undefined && asking !== owner) throw this.crossRoute(absolute, asking, owner)
    if (owner === undefined) return super.resolve(path, opts)
    const physical = await this.call(owner, () => owner.channel.request('realpath', { path: absolute }))
    throwIfAborted(opts?.signal, 'resolve')
    return { targetKey: RoutedTargetKeys.of(owner.id, physical.path), displayPath: absolute }
  }

  override processPath(target: FsTarget): string {
    return RoutedTargetKeys.parse(target.targetKey)?.path ?? super.processPath(target)
  }

  override fileUrl(target: FsTarget): string {
    const routed = RoutedTargetKeys.parse(target.targetKey)
    return routed === undefined ? super.fileUrl(target) : pathToFileURL(routed.path).href
  }

  override contains(parent: FsTarget, child: FsTarget): boolean {
    const outer = RoutedTargetKeys.parse(parent.targetKey)
    const inner = RoutedTargetKeys.parse(child.targetKey)
    if (outer === undefined && inner === undefined) return super.contains(parent, child)
    return outer !== undefined && inner !== undefined && outer.id === inner.id && RoutePaths.contains(outer.path, inner.path)
  }

  override watch(target: FsTarget, changed: (error?: Error) => void, signal: AbortSignal): Promise<() => Promise<void>> {
    const routed = this.routed(target)
    if (routed === undefined) return super.watch(target, changed, signal)
    return Promise.reject(
      new FsError(`watching "${target.displayPath}" is not available inside sandbox ${routed.route.id}; read it again to see changes`, 'FS_IO_ERROR'),
    )
  }

  override async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    const routed = this.routed(target)
    if (routed === undefined) return super.stat(target, signal)
    throwIfAborted(signal, 'stat')
    const info = await this.guestStat(routed, true)
    if (info === null) return undefined
    return { version: FsVersion(info.version), type: infoType(info.type), size: info.size }
  }

  override async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    if (path.trim().length === 0) return super.lstat(path, opts, signal)
    const routes = this.ctx.sandboxRoutes
    const absolute = RoutePaths.absolute(path, opts?.cwd ?? this.config.cwd)
    const owner = routes.forPath(absolute)
    const asking = opts?.cwd === undefined ? owner : routes.forPath(opts.cwd)
    if (asking !== owner) throw this.crossRoute(absolute, asking, owner)
    if (owner === undefined) return super.lstat(path, opts, signal)
    throwIfAborted(signal, 'lstat')
    const info = await this.guestStat({ route: owner, path: absolute }, false)
    if (info === null) return undefined
    return { version: FsVersion(info.version), type: info.type, size: info.size }
  }

  override async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    const routed = this.routed(target)
    if (routed === undefined) return super.readText(target, signal)
    const bytes = await this.readWhole(routed, signal, undefined)
    if (bytes.subarray(0, BINARY_SAMPLE_BYTES).includes(0)) throw new FsError(`cannot read "${target.displayPath}": binary file`, 'FS_NOT_TEXT')
    return Text.decode(bytes, 'read', target.displayPath)
  }

  override async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    if (this.routed(target) === undefined) return super.streamText(target, signal)
    const text = await this.readText(target, signal)
    return (async function* () {
      yield text
    })()
  }

  override async readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    const routed = this.routed(target)
    if (routed === undefined) return super.readBytes(target, signal, maxBytes)
    return this.readWhole(routed, signal, maxBytes)
  }

  override async readByteRange(target: FsTarget, range: { offset: number; length: number }, signal?: AbortSignal): Promise<Uint8Array> {
    const routed = this.routed(target)
    if (routed === undefined) return super.readByteRange(target, range, signal)
    throwIfAborted(signal, 'read')
    const read = await this.call(routed.route, () => routed.route.channel.request('read', { path: routed.path, offset: range.offset, length: range.length }))
    return Buffer.from(read.data, 'base64')
  }

  override async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    const routed = this.routed(target)
    if (routed === undefined) return super.listDir(target, signal)
    throwIfAborted(signal, 'list')
    const { route } = routed
    const listed = await this.call(route, () => route.channel.request('list', { path: routed.path }))
    const entries: FsDirEntry[] = []
    for (const entry of listed.entries) {
      const child = join(routed.path, entry.name)
      // A symlink is listed as what it points at, under the identity the link resolves to, as the local provider does.
      const followed = entry.type === 'symlink' ? await this.guestStat({ route, path: child }, true) : entry
      const physical = entry.type === 'symlink' ? (await this.call(route, () => route.channel.request('realpath', { path: child }))).path : child
      const listed: FsDirEntry = {
        name: entry.name,
        type: followed === null ? 'other' : infoType(followed.type),
        target: { targetKey: RoutedTargetKeys.of(route.id, physical), displayPath: join(target.displayPath, entry.name) },
      }
      if (followed !== null) {
        listed.version = FsVersion(followed.version)
        listed.size = followed.size
      }
      entries.push(listed)
    }
    return entries
  }

  override async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsWriteOutcome> {
    const routed = this.routed(target)
    if (routed === undefined) return super.writeText(target, content, expected, signal, sandboxPolicy)
    this.fence(routed, target, 'write', sandboxPolicy)
    return this.locked([routed], () => this.writeRouted(routed, target, content, expected, signal))
  }

  override async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: FsVersion },
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsEditOutcome> {
    const routed = this.routed(target)
    if (routed === undefined) return super.editText(target, edit, expected, signal, sandboxPolicy)
    this.fence(routed, target, 'edit', sandboxPolicy)
    return this.locked([routed], async () => {
      const existing = await this.requireRoutedFile(routed, target, expected, 'edit')
      const original = await this.readForEdit(routed, target, signal)
      const after = Text.literalEdit(original.content, edit, target.displayPath)
      const version = await this.replace(routed, Text.restore(after, original.lineEndings), existing.version, signal)
      return { version, before: original.content, after }
    })
  }

  override async patchText(
    target: FsTarget,
    hunks: readonly PatchHunk[],
    expected?: { version: FsVersion },
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsEditOutcome> {
    const routed = this.routed(target)
    if (routed === undefined) return super.patchText(target, hunks, expected, signal, sandboxPolicy)
    this.fence(routed, target, 'patch', sandboxPolicy)
    return this.locked([routed], async () => {
      const existing = await this.requireRoutedFile(routed, target, expected, 'patch')
      const original = await this.readForEdit(routed, target, signal)
      const after = this.patched(target, original.content, hunks)
      const version = await this.replace(routed, Text.restore(after, original.lineEndings), existing.version, signal)
      return { version, before: original.content, after }
    })
  }

  override async deleteFile(
    target: FsTarget,
    expected?: { version: FsVersion },
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsDeleteOutcome> {
    const routed = this.routed(target)
    if (routed === undefined) return super.deleteFile(target, expected, signal, sandboxPolicy)
    this.fence(routed, target, 'delete', sandboxPolicy)
    return this.locked([routed], async () => {
      const existing = await this.requireRoutedFile(routed, target, expected, 'delete')
      const before = await this.diffBasis(routed, existing, signal)
      throwIfAborted(signal, 'delete')
      await this.call(routed.route, () => routed.route.channel.request('delete', { path: routed.path, version: existing.version }), 'delete')
      return { before }
    })
  }

  override async moveFile(
    source: FsTarget,
    destination: FsTarget,
    options: Parameters<SandboxedFileSystem['moveFile']>[2],
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsMoveOutcome> {
    const from = this.routed(source)
    const to = this.routed(destination)
    if (from === undefined && to === undefined) return super.moveFile(source, destination, options, signal, sandboxPolicy)
    if (from === undefined || to === undefined || from.route.id !== to.route.id)
      throw new FsError(
        `cannot move "${source.displayPath}" to "${destination.displayPath}": a move cannot cross a sandbox boundary; write the destination and delete the source instead`,
        'FS_SANDBOX_DENIED',
      )
    if (source.targetKey === destination.targetKey) throw new FsError(`cannot move "${source.displayPath}" to itself`, 'FS_SAME_TARGET')
    this.fence(from, source, 'move', sandboxPolicy)
    this.fence(to, destination, 'move', sandboxPolicy)
    return this.locked([from, to], async () => {
      const sourceInfo = await this.requireRoutedFile(from, source, options.expectedSource, 'move')
      const original = await this.readForEdit(from, source, signal)
      const after = options.hunks === undefined ? original.content : this.patched(source, original.content, options.hunks)
      const destinationOutcome = await this.writeRouted(to, destination, Text.restore(after, original.lineEndings), options.expectedDestination, undefined)
      const outcome: FsWriteOutcome = { ...destinationOutcome, after }
      const sourceBefore = Buffer.byteLength(original.content, 'utf8') < this.config.diffBasisMaxBytes ? original.content : null
      try {
        await this.call(from.route, () => from.route.channel.request('delete', { path: from.path, version: sourceInfo.version }), 'move')
      } catch (error) {
        if (!(error instanceof FsError)) throw error
        return { sourceBefore, destination: outcome, sourceDeleted: false, sourceFailure: { code: error.code, message: error.message } }
      }
      return { sourceBefore, destination: outcome, sourceDeleted: true }
    })
  }

  /** The routed half of a target, or `undefined` for a local target. A sandbox that closed is an error with a recovery. */
  private routed(target: FsTarget): RoutedTarget | undefined {
    const parsed = RoutedTargetKeys.parse(target.targetKey)
    if (parsed === undefined) return undefined
    const route = this.ctx.sandboxRoutes.get(parsed.id)
    if (route === undefined)
      throw new FsError(
        `"${target.displayPath}" is in sandbox ${parsed.id}, which is not running. Start it from the Sandboxes page (or the sandbox_start tool), then retry.`,
        'FS_IO_ERROR',
      )
    return { route, path: parsed.path }
  }

  private crossRoute(path: string, asking: SandboxRoute | undefined, owner: SandboxRoute | undefined): FsError {
    if (asking === undefined)
      return new FsError(`"${path}" is inside sandbox ${owner?.id ?? '?'}; only the thread that runs in that sandbox can reach it`, 'FS_SANDBOX_DENIED')
    return new FsError(
      `"${path}" is outside sandbox ${asking.id}, which only reaches ${asking.root}. Copy what you need into the workspace, or ask the user to mount it into the sandbox.`,
      'FS_SANDBOX_DENIED',
    )
  }

  /**
   * The routed half of the stock write fence. The sandbox is the isolation boundary; the policy still decides which
   * of its folders a call may change: nothing under `read-only`, the workspace and `/tmp` under `workspace-write`.
   */
  private fence(routed: RoutedTarget, target: FsTarget, verb: string, policy: SandboxExecutionPolicy | undefined): void {
    const mode = policy?.mode ?? 'workspace-write'
    if (mode === 'danger-full-access') return
    if (mode === 'read-only')
      throw new FsError(`cannot ${verb} "${target.displayPath}": this thread is read-only; ask the user to allow workspace writes`, 'FS_SANDBOX_DENIED')
    if (RoutePaths.contains(routed.route.root, routed.path) || RoutePaths.contains('/tmp', routed.path)) return
    throw new FsError(
      `cannot ${verb} "${target.displayPath}": outside the sandbox workspace ${routed.route.root}; ask the user to allow full access for this call`,
      'FS_SANDBOX_DENIED',
    )
  }

  private async call<T>(route: SandboxRoute, request: () => Promise<T>, verb?: 'delete' | 'move'): Promise<T> {
    try {
      return await request()
    } catch (error) {
      const failure = asFsError(error, route)
      // The local provider reports a source that vanished under a guarded delete as stale, not missing.
      if (verb !== undefined && failure instanceof FsError && failure.code === 'FS_NOT_FOUND')
        throw new FsError(`cannot ${verb}: file changed since it was read`, 'FS_STALE_VERSION', { cause: failure })
      throw failure
    }
  }

  private guestStat(routed: RoutedTarget, follow: boolean): Promise<GuestStat | null> {
    return this.call(routed.route, () => routed.route.channel.request('stat', { path: routed.path, follow }))
  }

  private async readWhole(routed: RoutedTarget, signal: AbortSignal | undefined, max: number | undefined): Promise<Buffer> {
    throwIfAborted(signal, 'read')
    const read = await this.call(routed.route, () =>
      routed.route.channel.request('read', max === undefined ? { path: routed.path } : { path: routed.path, max }),
    )
    throwIfAborted(signal, 'read')
    return Buffer.from(read.data, 'base64')
  }

  private async readForEdit(routed: RoutedTarget, target: FsTarget, signal: AbortSignal | undefined) {
    const bytes = await this.readWhole(routed, signal, undefined)
    if (bytes.includes(0)) throw new FsError(`cannot edit "${target.displayPath}": binary file`, 'FS_NOT_TEXT')
    const raw = Text.decode(bytes, 'edit', target.displayPath)
    return { content: Text.normalize(raw), lineEndings: Text.lineEndings(raw) }
  }

  /** The LF text of an existing file below the diff-basis limit, else `null`, as the local provider's overwrite diff. */
  private async diffBasis(routed: RoutedTarget, existing: GuestStat, signal: AbortSignal | undefined): Promise<string | null> {
    if (existing.size >= this.config.diffBasisMaxBytes) return null
    try {
      const bytes = await this.readWhole(routed, signal, this.config.diffBasisMaxBytes - 1)
      if (bytes.includes(0)) return null
      return Text.normalize(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    } catch (error) {
      if (error instanceof FsError && error.code === 'FS_ABORTED') throw error
      return null
    }
  }

  private async requireRoutedFile(routed: RoutedTarget, target: FsTarget, expected: { version: FsVersion } | undefined, verb: string): Promise<GuestStat> {
    const existing = await this.guestStat(routed, true)
    if (existing === null) throw new FsError(`cannot ${verb} "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
    if (existing.type !== 'file') throw new FsError(`cannot ${verb} "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
    if (expected !== undefined && existing.version !== expected.version)
      throw new FsError(`cannot ${verb} "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
    return existing
  }

  private patched(target: FsTarget, before: string, hunks: readonly PatchHunk[]): string {
    const result = applyHunks(before, hunks)
    if (!result.ok)
      throw new FsError(
        `cannot patch "${target.displayPath}": hunk at patch line ${result.failure.hunkLineNumber} (${result.failure.stage}) does not match`,
        'FS_PATCH_MISMATCH',
      )
    return result.after
  }

  /** Write the edited content only over the version that was read: a change in the sandbox meanwhile is stale. */
  private async replace(routed: RoutedTarget, content: string, version: string, signal: AbortSignal | undefined): Promise<FsVersion> {
    throwIfAborted(signal, 'edit')
    const written = await this.call(routed.route, () =>
      routed.route.channel.request('write', {
        path: routed.path,
        data: Buffer.from(content).toString('base64'),
        intent: { kind: 'replaceIfVersion', version },
      }),
    )
    return FsVersion(written.version)
  }

  private async writeRouted(
    routed: RoutedTarget,
    target: FsTarget,
    content: string,
    expected: FsWriteIntent | undefined,
    signal: AbortSignal | undefined,
  ): Promise<FsWriteOutcome> {
    const existing = await this.guestStat(routed, true)
    if (existing !== null && existing.type !== 'file') throw new FsError(`cannot write "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
    if (expected?.kind === 'replaceIfVersion') {
      if (existing === null) throw new FsError(`cannot write "${target.displayPath}": file no longer exists`, 'FS_STALE_VERSION')
      if (existing.version !== expected.version) throw new FsError(`cannot write "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
    } else if (expected?.kind === 'createIfAbsent' && existing !== null) {
      throw new FsError(`cannot overwrite existing "${target.displayPath}" without reading it first`, 'FS_NOT_OBSERVED')
    }
    const before =
      existing !== null && Buffer.byteLength(content, 'utf8') < this.config.diffBasisMaxBytes ? await this.diffBasis(routed, existing, signal) : null
    throwIfAborted(signal, 'write')
    // The intent the guest checks again at the moment of writing: what this call saw is what it replaces.
    const intent: GuestWriteIntent = existing === null ? { kind: 'createIfAbsent' } : { kind: 'replaceIfVersion', version: existing.version }
    let written
    try {
      written = await routed.route.channel.request('write', { path: routed.path, data: Buffer.from(content).toString('base64'), intent })
    } catch (error) {
      if (error instanceof GuestError && (error.code === 'FS_ALREADY_EXISTS' || error.code === 'FS_STALE_VERSION' || error.code === 'FS_NOT_FOUND'))
        throw new FsError(`cannot write "${target.displayPath}": file changed while it was being written`, 'FS_STALE_VERSION', { cause: error })
      throw asFsError(error, routed.route)
    }
    return { operation: existing === null ? 'create' : 'update', version: FsVersion(written.version), before, after: Text.normalize(content) }
  }

  /** Run `operation` after every earlier mutation of the same targets has settled. */
  private async locked<T>(targets: readonly RoutedTarget[], operation: () => Promise<T>): Promise<T> {
    const keys = [...new Set(targets.map(target => `${target.route.id}:${resolve(target.path)}`))].sort()
    const earlier = keys.map(key => this.routedLocks.get(key) ?? Promise.resolve())
    const run = Promise.all(earlier).then(operation)
    const tail = run.then(
      () => undefined,
      () => undefined,
    )
    for (const key of keys) this.routedLocks.set(key, tail)
    try {
      return await run
    } finally {
      for (const key of keys) if (this.routedLocks.get(key) === tail) this.routedLocks.delete(key)
    }
  }
}

export default RoutedFileSystem
