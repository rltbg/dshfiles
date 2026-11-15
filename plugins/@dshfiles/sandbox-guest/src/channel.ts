/**
 * The host end of the channel to a guest agent: requests matched to responses by id, and processes whose
 * output and exit arrive as messages on the same stream. A provider gives it the sandbox's stdin and stdout.
 */
import { Duplex, PassThrough, Writable, type Readable } from 'node:stream'
import { decodeJsonSafe } from '@dshfiles/dshx/json'
import { Schema } from 'effect'
import {
  PROTOCOL_VERSION,
  guestMessageSchema,
  resultSchemas,
  type GuestArguments,
  type GuestErrorCode,
  type GuestHello,
  type GuestOperation,
  type GuestResult,
  type HostToGuest,
} from './protocol.js'

export class GuestError extends Error {
  readonly code: GuestErrorCode | 'GUEST_CLOSED' | 'GUEST_PROTOCOL' | 'GUEST_CONNECTION_FAILED'

  constructor(code: GuestErrorCode | 'GUEST_CLOSED' | 'GUEST_PROTOCOL' | 'GUEST_CONNECTION_FAILED', message: string) {
    super(message)
    this.name = 'GuestError'
    this.code = code
  }
}

export interface GuestProcess {
  readonly stdin: Writable
  readonly stdout: Readable
  readonly stderr: Readable
  readonly done: Promise<{ readonly exitCode: number | null; readonly signal: NodeJS.Signals | null }>
  /** Signal the process group; with `graceMs`, the guest kills it that long later if it is still running. */
  kill(signal?: NodeJS.Signals, graceMs?: number): void
}

interface Pending {
  /** Decodes the response's result with the requested operation's schema, then settles the request. */
  readonly settle: (result: Schema.Schema.Type<typeof Schema.Unknown>) => void
  readonly reject: (error: Error) => void
}

interface Running {
  readonly stdout: PassThrough
  readonly stderr: PassThrough
  readonly settle: (exit: { readonly exitCode: number | null; readonly signal: NodeJS.Signals | null }) => void
}

export interface GuestChannelIo {
  /** The sandbox's stdin: requests go here. */
  readonly input: Writable
  /** The sandbox's stdout: responses and process output come from here. */
  readonly output: Readable
}

export class GuestChannel {
  readonly hello: Promise<GuestHello>
  readonly closed: Promise<void>
  private readonly pending = new Map<number, Pending>()
  private readonly running = new Map<number, Running>()
  private readonly sockets = new Map<number, Duplex>()
  private nextId = 0
  private failure: GuestError | undefined
  private buffered = ''
  private readonly io: GuestChannelIo

  constructor(io: GuestChannelIo) {
    this.io = io
    let greet: (hello: GuestHello) => void = () => undefined
    let refuse: (error: Error) => void = () => undefined
    this.hello = new Promise((resolve, reject) => {
      greet = resolve
      refuse = reject
    })
    // A rejection nobody awaited yet must not crash the Host; callers see it through `hello` or `request`.
    this.hello.catch(() => undefined)
    let finish: () => void = () => undefined
    this.closed = new Promise(resolve => {
      finish = resolve
    })
    io.output.setEncoding('utf8')
    io.output.on('data', (chunk: string) => {
      this.buffered += chunk
      let newline = this.buffered.indexOf('\n')
      while (newline >= 0) {
        const line = this.buffered.slice(0, newline)
        this.buffered = this.buffered.slice(newline + 1)
        if (line.trim() !== '') this.receive(line, greet, refuse)
        newline = this.buffered.indexOf('\n')
      }
    })
    const end = (): void => {
      this.fail(new GuestError('GUEST_CLOSED', 'the sandbox channel closed'))
      refuse(this.failure ?? new GuestError('GUEST_CLOSED', 'the sandbox channel closed'))
      finish()
    }
    io.output.on('end', end)
    io.output.on('close', end)
    io.output.on('error', end)
    io.input.on('error', end)
  }

  /** Send one request and wait for its answer. */
  request<K extends GuestOperation>(op: K, args: GuestArguments[K]): Promise<GuestResult<K>> {
    return this.send(op, args, () => undefined)
  }

  /**
   * Send one request; `received` runs synchronously when the answer is decoded, before any later line of the same
   * chunk is handled, which `spawn` needs so the first output of a fast process is not dropped.
   */
  private send<K extends GuestOperation>(op: K, args: GuestArguments[K], received: (result: GuestResult<K>) => void): Promise<GuestResult<K>> {
    if (this.failure !== undefined) return Promise.reject(this.failure)
    const id = (this.nextId += 1)
    const schema: Schema.Codec<GuestResult<K>> = resultSchemas[op]
    return new Promise((resolve, reject) => {
      this.pending.set(id, {
        settle: result => {
          const decoded = Schema.decodeUnknownResult(schema)(result)
          if (decoded._tag === 'Failure') {
            reject(new GuestError('GUEST_PROTOCOL', `the guest agent answered ${op} with an unexpected shape: ${String(decoded.failure)}`))
            return
          }
          received(decoded.success)
          resolve(decoded.success)
        },
        reject,
      })
      this.write({ t: 'req', id, op, a: args })
    })
  }

  /** Start a process in the sandbox. Its streams behave like a local child process's. */
  async spawn(input: GuestArguments['spawn']): Promise<GuestProcess> {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    let settle: Running['settle'] = () => undefined
    const done = new Promise<{ readonly exitCode: number | null; readonly signal: NodeJS.Signals | null }>(resolve => {
      settle = exit => {
        stdout.end()
        stderr.end()
        resolve(exit)
      }
    })
    const { p } = await this.send('spawn', input, result => this.running.set(result.p, { stdout, stderr, settle }))
    const stdin = new Writable({
      write: (chunk: Buffer, _encoding, callback) => {
        this.write({ t: 'in', p, d: Buffer.from(chunk).toString('base64') })
        callback()
      },
      final: callback => {
        this.write({ t: 'in-end', p })
        callback()
      },
    })
    return {
      stdin,
      stdout,
      stderr,
      done,
      kill: (signal = 'SIGTERM', graceMs) => {
        if (this.running.has(p)) this.request('kill', graceMs === undefined ? { p, signal } : { p, signal, graceMs }).catch(() => undefined)
      },
    }
  }

  /**
   * Open a TCP connection to a loopback port inside the sandbox, as a stream. A server in the sandbox (its DSH
   * runtime, a dev server) is reached this way with no published port.
   */
  async connect(port: number): Promise<Duplex> {
    let c = 0
    const socket = new Duplex({
      read: () => undefined,
      write: (chunk: Buffer, _encoding, callback) => {
        this.write({ t: 'sock', c, d: Buffer.from(chunk).toString('base64') })
        callback()
      },
      final: callback => {
        this.write({ t: 'sock-end', c })
        callback()
      },
    })
    await this.send('connect', { port }, result => {
      c = result.c
      this.sockets.set(c, socket)
    })
    socket.once('close', () => this.sockets.delete(c))
    return socket
  }

  /** End the channel: the guest agent stops every process and exits, and the sandbox with it. */
  close(): Promise<void> {
    if (!this.io.input.writableEnded) this.io.input.end()
    return this.closed
  }

  private write(message: HostToGuest): void {
    if (this.failure !== undefined) return
    this.io.input.write(`${JSON.stringify(message)}\n`)
  }

  private receive(line: string, greet: (hello: GuestHello) => void, refuse: (error: Error) => void): void {
    const decoded = decodeJsonSafe(guestMessageSchema, line)
    // Output that is not a protocol line (a stray print from the image's entrypoint) is ignored.
    if (decoded._tag === 'Failure') return
    const message = decoded.success
    switch (message.t) {
      case 'hello':
        if (message.v !== PROTOCOL_VERSION) {
          const error = new GuestError(
            'GUEST_PROTOCOL',
            `the guest agent speaks protocol ${message.v}; this DSH speaks ${PROTOCOL_VERSION}. Rebuild the sandbox image.`,
          )
          this.fail(error)
          refuse(error)
          return
        }
        greet(message)
        return
      case 'res': {
        const waiter = this.pending.get(message.id)
        if (waiter === undefined) return
        this.pending.delete(message.id)
        if (message.ok) waiter.settle(message.r)
        else waiter.reject(new GuestError(message.e.code, message.e.message))
        return
      }
      case 'out': {
        const target = this.running.get(message.p)
        if (target === undefined) return
        ;(message.f === 1 ? target.stdout : target.stderr).write(Buffer.from(message.d, 'base64'))
        return
      }
      case 'sock': {
        this.sockets.get(message.c)?.push(Buffer.from(message.d, 'base64'))
        return
      }
      case 'sock-end': {
        const socket = this.sockets.get(message.c)
        if (socket === undefined) return
        this.sockets.delete(message.c)
        if (message.e === undefined) socket.push(null)
        else socket.destroy(new GuestError('GUEST_CONNECTION_FAILED', message.e))
        return
      }
      case 'exit': {
        const target = this.running.get(message.p)
        if (target === undefined) return
        this.running.delete(message.p)
        target.settle({ exitCode: message.code, signal: message.signal })
      }
    }
  }

  private fail(error: GuestError): void {
    if (this.failure !== undefined) return
    this.failure = error
    for (const waiter of this.pending.values()) waiter.reject(error)
    this.pending.clear()
    for (const process of this.running.values()) process.settle({ exitCode: null, signal: 'SIGKILL' })
    for (const socket of this.sockets.values()) socket.destroy(error)
    this.sockets.clear()
    this.running.clear()
  }
}
