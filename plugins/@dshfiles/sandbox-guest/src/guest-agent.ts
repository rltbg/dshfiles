/**
 * The guest agent: the first process in a sandbox. It answers the user's DSH over this process's stdin and
 * stdout (one JSON object per line, see `protocol.ts`) with file operations and processes run here.
 *
 * It must stay one self-contained file that imports only Node builtins: providers start it with
 * `node --input-type=module -e <this file>` in images that hold nothing of dshfiles. Shapes are restated from
 * `protocol.ts` for that reason, and every request is read through `Args`, which checks each field it hands out.
 *
 * Arguments: `--root <absolute dir>` (the thread's workspace) and `--confine` (refuse any path outside the root;
 * used when the agent runs on the host itself, as the directory provider does).
 */
import { spawn, type ChildProcess } from 'node:child_process'
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
  type BigIntStats,
} from 'node:fs'
import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path'

const VERSION = 1
const SIGNALS: ReadonlySet<string> = new Set<NodeJS.Signals>(['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGHUP', 'SIGQUIT', 'SIGTSTP', 'SIGCONT', 'SIGUSR1', 'SIGUSR2'])
const isSignal = (name: string): name is NodeJS.Signals => SIGNALS.has(name)

class GuestError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

const bad = (message: string): GuestError => new GuestError('GUEST_BAD_REQUEST', message)

/**
 * One decoded JSON object from the host, read field by field with a check on each. This is the agent's only
 * parser: it cannot import a schema library (the file runs alone in images that hold nothing of dshfiles), so
 * the untyped boundary is confined to this class and every accessor below checks the shape it returns.
 */
class Args {
  readonly #value: object

  // oxlint-disable-next-line antislop/no-broad-object-parameters -- The parser's own input: any JSON object, checked field by field below.
  constructor(value: object) {
    this.#value = value
  }

  // oxlint-disable-next-line antislop/no-unknown-parameters -- The result of JSON.parse, checked here before any field is read.
  static from(value: unknown): Args {
    if (value === null || Array.isArray(value) || !(value instanceof Object)) throw bad('expected a JSON object')
    return new Args(value)
  }

  // oxlint-disable-next-line antislop/no-unknown-returns -- Private: every public accessor checks what this returns.
  #get(name: string): unknown {
    // oxlint-disable-next-line antislop/no-reflect-get -- Reading a field of an unchecked JSON object is what this parser exists to do.
    return Object.hasOwn(this.#value, name) ? Reflect.get(this.#value, name) : undefined
  }

  has(name: string): boolean {
    return this.#get(name) !== undefined
  }

  string(name: string): string {
    const value = this.#get(name)
    if (!(value instanceof Object) && String(value) === value) return value
    throw bad(`${name} must be a string`)
  }

  optionalString(name: string): string | undefined {
    return this.has(name) ? this.string(name) : undefined
  }

  number(name: string): number {
    const value = this.#get(name)
    if (Number.isFinite(value) && Number(value) === value) return value
    throw bad(`${name} must be a number`)
  }

  optionalNumber(name: string): number | undefined {
    return this.has(name) ? this.number(name) : undefined
  }

  boolean(name: string): boolean {
    const value = this.#get(name)
    if (value === true || value === false) return value
    throw bad(`${name} must be true or false`)
  }

  strings(name: string): string[] {
    const value = this.#get(name)
    if (!Array.isArray(value)) throw bad(`${name} must be a list of strings`)
    // oxlint-disable-next-line antislop/no-unknown-parameters -- Each element is checked on the next line.
    return value.map((item: unknown, index) => {
      if (!(item instanceof Object) && String(item) === item) return item
      throw bad(`${name}[${index}] must be a string`)
    })
  }

  object(name: string): Args {
    return Args.from(this.#get(name))
  }

  optionalStringMap(name: string): Record<string, string> {
    if (!this.has(name)) return {}
    const map = this.object(name)
    return Object.fromEntries(map.keys().map(key => [key, map.string(key)]))
  }

  keys(): string[] {
    return Object.keys(this.#value)
  }
}

const option = (name: string): string | undefined => {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}
const root = resolve(option('--root') ?? process.cwd())
const confine = process.argv.includes('--confine')

interface StatResult {
  readonly type: 'file' | 'directory' | 'symlink' | 'other'
  readonly size: number
  readonly version: string
}

type Outgoing =
  | {
      readonly t: 'hello'
      readonly v: number
      readonly uid: number
      readonly pid: number
      readonly platform: string
      readonly root: string
      readonly confine: boolean
    }
  | { readonly t: 'res'; readonly id: number; readonly ok: true; readonly r: object | null }
  | { readonly t: 'res'; readonly id: number; readonly ok: false; readonly e: { readonly code: string; readonly message: string } }
  | { readonly t: 'out'; readonly p: number; readonly f: 1 | 2; readonly d: string }
  | { readonly t: 'exit'; readonly p: number; readonly code: number | null; readonly signal: string | null }

const send = (message: Outgoing): void => {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

const versionOf = (info: BigIntStats): string => `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`
const typeOf = (info: BigIntStats): StatResult['type'] => {
  if (info.isFile()) return 'file'
  if (info.isDirectory()) return 'directory'
  if (info.isSymbolicLink()) return 'symlink'
  return 'other'
}

/** The errno code of a Node filesystem error (`ENOENT`, `EACCES`, …). */
const errnoCode = (error: unknown): string | undefined =>
  error instanceof Error && 'code' in error && String(error.code) === error.code ? error.code : undefined

const fsFailure = (error: unknown, path: string): GuestError => {
  if (error instanceof GuestError) return error
  switch (errnoCode(error)) {
    case 'ENOENT':
      return new GuestError('FS_NOT_FOUND', `${path} does not exist`)
    case 'ENOTDIR':
      return new GuestError('FS_NOT_DIRECTORY', `a parent of ${path} is not a directory`)
    case 'EACCES':
    case 'EPERM':
    case 'EROFS':
      return new GuestError('FS_PERMISSION_DENIED', `permission denied: ${path}`)
    case 'EEXIST':
      return new GuestError('FS_ALREADY_EXISTS', `${path} already exists`)
    default:
      return new GuestError('FS_IO_ERROR', `${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** The physical path of `path`, or of its nearest existing ancestor joined with the rest, so a symlink cannot lead out. */
const physical = (path: string): string => {
  let existing = path
  const rest: string[] = []
  for (;;) {
    try {
      return join(realpathSync(existing), ...rest.reverse())
    } catch (error) {
      if (errnoCode(error) !== 'ENOENT' || dirname(existing) === existing) throw error
      rest.push(existing.slice(dirname(existing).length + 1))
      existing = dirname(existing)
    }
  }
}

const insideRoot = (candidate: string): boolean => {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** An absolute path the request may touch. With `--confine`, it must stay under the root after symlinks. */
const allowed = (path: string): string => {
  if (!isAbsolute(path)) throw bad(`expected an absolute path, got ${path}`)
  const normalized = resolve(path)
  if (confine && !(insideRoot(normalized) && insideRoot(physical(normalized)))) {
    throw new GuestError('FS_SANDBOX_DENIED', `${path} is outside the sandbox workspace ${root}`)
  }
  return normalized
}

const statOf = (path: string, follow: boolean): StatResult | null => {
  try {
    const info = follow ? statSync(path, { bigint: true }) : lstatSync(path, { bigint: true })
    return { type: typeOf(info), size: Number(info.size), version: versionOf(info) }
  } catch (error) {
    if (errnoCode(error) === 'ENOENT' || errnoCode(error) === 'ENOTDIR') return null
    throw fsFailure(error, path)
  }
}

const readFile = (path: string, max: number | undefined, offset: number | undefined, length: number | undefined) => {
  let descriptor: number | undefined
  try {
    descriptor = openSync(path, 'r')
    const info = statSync(path, { bigint: true })
    if (!info.isFile()) throw new GuestError('FS_NOT_REGULAR_FILE', `${path} is not a regular file`)
    const size = Number(info.size)
    if (max !== undefined && offset === undefined && size > max) throw new GuestError('FS_TOO_LARGE', `${path} is ${size} bytes, above the ${max}-byte limit`)
    const start = offset ?? 0
    const want = Math.max(0, Math.min(length ?? size - start, size - start))
    const buffer = Buffer.alloc(want)
    let filled = 0
    while (filled < want) {
      const read = readSync(descriptor, buffer, filled, want - filled, start + filled)
      if (read === 0) break
      filled += read
    }
    return { data: buffer.subarray(0, filled).toString('base64'), size, version: versionOf(info) }
  } catch (error) {
    throw fsFailure(error, path)
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

let temporaryCounter = 0

/** Atomic write: a temporary file beside the target, then a rename. The version check and the rename run in one turn of this process. */
const writeFile = (path: string, data: string, intent: Args) => {
  const kind = intent.string('kind')
  const current = statOf(path, true)
  if (kind === 'createIfAbsent' && current !== null) throw new GuestError('FS_ALREADY_EXISTS', `${path} already exists`)
  if (kind === 'replaceIfVersion') {
    if (current === null) throw new GuestError('FS_NOT_FOUND', `${path} does not exist`)
    if (current.version !== intent.string('version')) throw new GuestError('FS_STALE_VERSION', `${path} changed since it was read`)
  }
  if (current !== null && current.type !== 'file') throw new GuestError('FS_NOT_REGULAR_FILE', `${path} is not a regular file`)
  const temporary = join(dirname(path), `.${process.pid}.${(temporaryCounter += 1)}.sandbox-write`)
  try {
    mkdirSync(dirname(path), { recursive: true })
    const descriptor = openSync(temporary, 'wx', 0o644)
    try {
      writeSync(descriptor, Buffer.from(data, 'base64'))
      fsyncSync(descriptor)
    } finally {
      closeSync(descriptor)
    }
    renameSync(temporary, path)
  } catch (error) {
    try {
      unlinkSync(temporary)
    } catch {
      // The temporary file was never created, or was already renamed.
    }
    throw fsFailure(error, path)
  }
  return { version: versionOf(statSync(path, { bigint: true })), created: current === null }
}

const which = (command: string): string | null => {
  if (command.includes('/')) return statOf(resolve(command), true) === null ? null : resolve(command)
  for (const directory of (process.env['PATH'] ?? '').split(delimiter)) {
    if (directory === '') continue
    const candidate = join(directory, command)
    if (statOf(candidate, true)?.type === 'file') return candidate
  }
  return null
}

const processes = new Map<number, ChildProcess>()
let nextProcess = 0

const startProcess = (argv: readonly string[], cwd: string, env: Readonly<Record<string, string>>) => {
  const command = argv[0]
  if (command === undefined) throw bad('argv is empty')
  const environment: NodeJS.ProcessEnv = { ...process.env, ...env }
  const p = (nextProcess += 1)
  let child: ChildProcess
  try {
    child = spawn(command, argv.slice(1), { cwd, env: environment, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
  } catch (error) {
    throw new GuestError('GUEST_SPAWN_FAILED', `${command}: ${error instanceof Error ? error.message : String(error)}`)
  }
  processes.set(p, child)
  child.stdout?.on('data', (chunk: Buffer) => send({ t: 'out', p, f: 1, d: chunk.toString('base64') }))
  child.stderr?.on('data', (chunk: Buffer) => send({ t: 'out', p, f: 2, d: chunk.toString('base64') }))
  child.stdin?.on('error', () => undefined)
  let exited = false
  const exit = (code: number | null, signal: string | null): void => {
    if (exited) return
    exited = true
    processes.delete(p)
    send({ t: 'exit', p, code, signal })
  }
  child.on('error', error => {
    send({ t: 'out', p, f: 2, d: Buffer.from(`${command}: ${error.message}\n`).toString('base64') })
    exit(127, null)
  })
  child.on('close', (code, signal) => exit(code, signal))
  return { p }
}

const signalGroup = (p: number, signal: string): void => {
  const child = processes.get(p)
  if (child?.pid === undefined) throw new GuestError('GUEST_NO_PROCESS', `no running process ${p}`)
  if (!isSignal(signal)) throw bad(`unsupported signal ${signal}`)
  try {
    process.kill(-child.pid, signal)
  } catch {
    child.kill(signal)
  }
}

const operations = {
  ping: () => ({}),
  realpath: (args: Args) => {
    const path = allowed(args.string('path'))
    try {
      return { path: realpathSync(path) }
    } catch (error) {
      throw fsFailure(error, path)
    }
  },
  stat: (args: Args) => statOf(allowed(args.string('path')), args.has('follow') ? args.boolean('follow') : true),
  list: (args: Args) => {
    const path = allowed(args.string('path'))
    try {
      const entries = readdirSync(path).map(name => ({ name, ...(statOf(join(path, name), false) ?? { type: 'other', size: 0, version: '' }) }))
      return { entries }
    } catch (error) {
      throw fsFailure(error, path)
    }
  },
  read: (args: Args) => readFile(allowed(args.string('path')), args.optionalNumber('max'), args.optionalNumber('offset'), args.optionalNumber('length')),
  write: (args: Args) => writeFile(allowed(args.string('path')), args.string('data'), args.object('intent')),
  delete: (args: Args) => {
    const path = allowed(args.string('path'))
    const expected = args.optionalString('version')
    const current = statOf(path, true)
    if (current === null) throw new GuestError('FS_NOT_FOUND', `${path} does not exist`)
    if (expected !== undefined && current.version !== expected) throw new GuestError('FS_STALE_VERSION', `${path} changed since it was read`)
    try {
      unlinkSync(path)
    } catch (error) {
      throw fsFailure(error, path)
    }
    return {}
  },
  rename: (args: Args) => {
    const from = allowed(args.string('from'))
    const to = allowed(args.string('to'))
    try {
      mkdirSync(dirname(to), { recursive: true })
      renameSync(from, to)
    } catch (error) {
      throw fsFailure(error, from)
    }
    return {}
  },
  which: (args: Args) => ({ path: which(args.string('command')) }),
  spawn: (args: Args) => startProcess(args.strings('argv'), allowed(args.string('cwd')), args.optionalStringMap('env')),
  kill: (args: Args) => {
    signalGroup(args.number('p'), args.optionalString('signal') ?? 'SIGTERM')
    return {}
  },
} satisfies Record<string, (args: Args) => object | null>

const isOperation = (name: string): name is keyof typeof operations => Object.hasOwn(operations, name)

const handle = (message: Args): void => {
  const kind = message.string('t')
  if (kind === 'in' || kind === 'in-end') {
    const child = processes.get(message.number('p'))
    if (child === undefined) return
    if (kind === 'in') child.stdin?.write(Buffer.from(message.string('d'), 'base64'))
    else child.stdin?.end()
    return
  }
  if (kind !== 'req') return
  const id = message.number('id')
  try {
    const op = message.string('op')
    if (!isOperation(op)) throw bad(`unknown operation ${op}`)
    send({ t: 'res', id, ok: true, r: operations[op](message.has('a') ? message.object('a') : Args.from({})) })
  } catch (error) {
    const failure = error instanceof GuestError ? error : new GuestError('FS_IO_ERROR', error instanceof Error ? error.message : String(error))
    send({ t: 'res', id, ok: false, e: { code: failure.code, message: failure.message } })
  }
}

let pending = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk: string) => {
  pending += chunk
  let newline = pending.indexOf('\n')
  while (newline >= 0) {
    const line = pending.slice(0, newline)
    pending = pending.slice(newline + 1)
    if (line.trim() !== '') {
      try {
        // The agent cannot import the repository's validated JSON decoder: it runs alone in images that hold nothing
        // of dshfiles. Args.from and its accessors are its validation, field by field.
        // ast-grep-ignore: no-direct-json-parse
        handle(Args.from(JSON.parse(line)))
      } catch {
        // A line that is not a well-formed message is ignored; the host only sends protocol lines.
      }
    }
    newline = pending.indexOf('\n')
  }
})
// The host closing the channel ends the sandbox: stop every process group, then exit.
process.stdin.on('end', () => {
  for (const p of processes.keys()) {
    try {
      signalGroup(p, 'SIGKILL')
    } catch {
      // Already gone.
    }
  }
  process.exit(0)
})

send({ t: 'hello', v: VERSION, uid: process.getuid?.() ?? -1, pid: process.pid, platform: process.platform, root, confine })
