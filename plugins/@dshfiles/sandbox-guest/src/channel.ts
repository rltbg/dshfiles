/**
 * The host end of the channel to a guest agent: requests matched to responses by id, and processes whose
 * output and exit arrive as messages on the same stream. A provider gives it the sandbox's stdin and stdout.
 */
import { PassThrough, Writable, type Readable } from 'node:stream'
import {
  PROTOCOL_VERSION,
  type GuestErrorCode,
  type GuestHello,
  type GuestOperation,
  type GuestOperations,
  type GuestToHost,
  type HostToGuest,
} from './protocol.js'

export class GuestError extends Error {
  readonly code: GuestErrorCode | 'GUEST_CLOSED' | 'GUEST_PROTOCOL'

  constructor(code: GuestErrorCode | 'GUEST_CLOSED' | 'GUEST_PROTOCOL', message: string) {
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
  kill(signal?: NodeJS.Signals): void
}

/** Any operation's result, as the guest agent sends it. */
type GuestResult = GuestOperations[GuestOperation]['result']

interface Pending {
  readonly resolve: (value: GuestResult) => void
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
  request<K extends GuestOperation>(op: K, args: GuestOperations[K]['args']): Promise<GuestOperations[K]['result']> {
    if (this.failure !== undefined) return Promise.reject(this.failure)
    const id = (this.nextId += 1)
    return new Promise((resolve, reject) => {
      // SAFETY: the guest agent answers request `id` with the result shape of the operation it was sent (protocol.ts);
      // guest-agent.test.ts runs the real agent through every operation.
      this.pending.set(id, { resolve: value => resolve(value as GuestOperations[K]['result']), reject })
      this.write({ t: 'req', id, op, a: args })
    })
  }

  /** Start a process in the sandbox. Its streams behave like a local child process's. */
  async spawn(input: GuestOperations['spawn']['args']): Promise<GuestProcess> {
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
    const { p } = await this.request('spawn', input)
    this.running.set(p, { stdout, stderr, settle })
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
      kill: (signal = 'SIGTERM') => {
        if (this.running.has(p)) this.request('kill', { p, signal }).catch(() => undefined)
      },
    }
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
    let message: GuestToHost
    try {
      // SAFETY: the guest agent writes only the GuestToHost shapes of protocol.ts on this stream, and a line that is
      // not one of them falls through the switch below without effect.
      message = JSON.parse(line) as GuestToHost
    } catch {
      // Output that is not a protocol line (a stray print from the image's entrypoint) is ignored.
      return
    }
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
        if (message.ok) waiter.resolve(message.r)
        else waiter.reject(new GuestError(message.e.code, message.e.message))
        return
      }
      case 'out': {
        const target = this.running.get(message.p)
        if (target === undefined) return
        ;(message.f === 1 ? target.stdout : target.stderr).write(Buffer.from(message.d, 'base64'))
        return
      }
      case 'exit': {
        const target = this.running.get(message.p)
        if (target === undefined) return
        this.running.delete(message.p)
        // SAFETY: the guest agent reports the exit signal name Node gave it, which is a NodeJS.Signals value or null.
        target.settle({ exitCode: message.code, signal: message.signal as NodeJS.Signals | null })
      }
    }
  }

  private fail(error: GuestError): void {
    if (this.failure !== undefined) return
    this.failure = error
    for (const waiter of this.pending.values()) waiter.reject(error)
    this.pending.clear()
    for (const process of this.running.values()) process.settle({ exitCode: null, signal: 'SIGKILL' })
    this.running.clear()
  }
}
