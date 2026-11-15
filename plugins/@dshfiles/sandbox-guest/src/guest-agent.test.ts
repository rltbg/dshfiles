import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { decodeJsonSafe } from '@dshfiles/dshx/json'
import { Schema } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'
import { GuestChannel, GuestError } from './channel.js'
import { GuestLauncher, type StartedGuest } from './launch.js'
import { PROTOCOL_VERSION } from './protocol.js'

const started: StartedGuest[] = []
const folders: string[] = []

afterEach(async () => {
  await Promise.all(started.splice(0).map(guest => guest.channel.close()))
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

const scratch = (): string => {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'sandbox-guest-')))
  folders.push(folder)
  return folder
}

const local = () => {
  const root = scratch()
  const guest = GuestLauncher.startLocal({ root })
  started.push(guest)
  return { channel: guest.channel, root }
}

const text = (base64: string): string => Buffer.from(base64, 'base64').toString('utf8')
const b64 = (value: string): string => Buffer.from(value).toString('base64')
const codeOf = (promise: Promise<unknown>): Promise<string> =>
  promise.then(
    () => 'resolved',
    (error: unknown) => (error instanceof GuestError ? error.code : String(error)),
  )

const collect = async (channel: GuestChannel, argv: readonly string[], cwd: string, input?: string) => {
  const process = await channel.spawn({ argv, cwd })
  let stdout = ''
  let stderr = ''
  process.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
  process.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
  if (input !== undefined) process.stdin.write(input)
  process.stdin.end()
  const exit = await process.done
  return { ...exit, stdout, stderr }
}

describe('the guest agent over a local process', () => {
  it('greets with the protocol version and its confined root', async () => {
    const { channel, root } = local()
    const hello = await channel.hello
    expect(hello).toMatchObject({ t: 'hello', v: PROTOCOL_VERSION, root, confine: true })
    await expect(channel.request('ping', {})).resolves.toEqual({})
  })

  it('writes, reads, stats and lists, with a version that changes on every write', async () => {
    const { channel, root } = local()
    const path = join(root, 'src', 'a.txt')
    const first = await channel.request('write', { path, data: b64('one\n'), intent: { kind: 'createIfAbsent' } })
    expect(first.created).toBe(true)
    const read = await channel.request('read', { path })
    expect(text(read.data)).toBe('one\n')
    expect(read.version).toBe(first.version)
    const second = await channel.request('write', { path, data: b64('two\n'), intent: { kind: 'replaceIfVersion', version: first.version } })
    expect(second.version).not.toBe(first.version)
    expect(await channel.request('stat', { path, follow: true })).toMatchObject({ type: 'file', size: 4, version: second.version })
    expect(await channel.request('stat', { path: join(root, 'missing'), follow: true })).toBeNull()
    symlinkSync(join(root, 'src'), join(root, 'alias'))
    expect(await channel.request('realpath', { path: join(root, 'alias', 'new', 'b.txt') })).toEqual({ path: join(root, 'src', 'new', 'b.txt') })
    const listed = await channel.request('list', { path: join(root, 'src') })
    expect(listed.entries.map(entry => [entry.name, entry.type])).toEqual([['a.txt', 'file']])
  })

  it('refuses a stale version, an existing file on create, and a missing file on replace', async () => {
    const { channel, root } = local()
    const path = join(root, 'a.txt')
    const first = await channel.request('write', { path, data: b64('one'), intent: { kind: 'any' } })
    await channel.request('write', { path, data: b64('two'), intent: { kind: 'any' } })
    expect(await codeOf(channel.request('write', { path, data: b64('three'), intent: { kind: 'replaceIfVersion', version: first.version } }))).toBe(
      'FS_STALE_VERSION',
    )
    expect(await codeOf(channel.request('write', { path, data: b64('x'), intent: { kind: 'createIfAbsent' } }))).toBe('FS_ALREADY_EXISTS')
    expect(await codeOf(channel.request('write', { path: join(root, 'b'), data: b64('x'), intent: { kind: 'replaceIfVersion', version: 'v' } }))).toBe(
      'FS_NOT_FOUND',
    )
    expect(await codeOf(channel.request('delete', { path, version: first.version }))).toBe('FS_STALE_VERSION')
  })

  it('reads a byte window and refuses a file above the limit', async () => {
    const { channel, root } = local()
    const path = join(root, 'digits.txt')
    await channel.request('write', { path, data: b64('0123456789'), intent: { kind: 'any' } })
    expect(text((await channel.request('read', { path, offset: 3, length: 4 })).data)).toBe('3456')
    expect(await codeOf(channel.request('read', { path, max: 5 }))).toBe('FS_TOO_LARGE')
    expect(await codeOf(channel.request('read', { path: root }))).toBe('FS_NOT_REGULAR_FILE')
  })

  it('refuses paths outside its root when confined, including through a symlink and a missing parent', async () => {
    const { channel, root } = local()
    const outside = scratch()
    writeFileSync(join(outside, 'secret'), 'host secret')
    symlinkSync(outside, join(root, 'escape'))
    expect(await codeOf(channel.request('read', { path: join(outside, 'secret') }))).toBe('FS_SANDBOX_DENIED')
    expect(await codeOf(channel.request('read', { path: join(root, 'escape', 'secret') }))).toBe('FS_SANDBOX_DENIED')
    expect(await codeOf(channel.request('write', { path: join(root, 'escape', 'new', 'file'), data: b64('x'), intent: { kind: 'any' } }))).toBe(
      'FS_SANDBOX_DENIED',
    )
    expect(await codeOf(channel.request('read', { path: `${root}/../${outside.split('/').pop()}/secret` }))).toBe('FS_SANDBOX_DENIED')
    expect(await codeOf(channel.request('read', { path: 'relative.txt' }))).toBe('GUEST_BAD_REQUEST')
    expect(await codeOf(channel.spawn({ argv: ['true'], cwd: outside }))).toBe('FS_SANDBOX_DENIED')
  })

  it('runs a process in the given folder with its output, input and exit code', async () => {
    const { channel, root } = local()
    mkdirSync(join(root, 'work'))
    const echoed = await collect(channel, ['sh', '-c', 'pwd; cat; echo oops >&2; exit 3'], join(root, 'work'), 'from stdin\n')
    expect(echoed.stdout).toBe(`${join(root, 'work')}\nfrom stdin\n`)
    expect(echoed.stderr).toBe('oops\n')
    expect(echoed.exitCode).toBe(3)
    const missing = await collect(channel, ['no-such-command-for-sure'], root)
    expect(missing.exitCode).toBe(127)
  })

  it('stops a whole process group on kill', async () => {
    const { channel, root } = local()
    const process = await channel.spawn({ argv: ['sh', '-c', 'sleep 30 & sleep 30; wait'], cwd: root })
    process.kill('SIGTERM')
    const exit = await process.done
    expect(exit.signal ?? exit.exitCode).not.toBe(0)
  })

  it('kills a group that ignores TERM once the grace period passes', async () => {
    const { channel, root } = local()
    const process = await channel.spawn({ argv: ['sh', '-c', "trap '' TERM; sleep 30 & wait"], cwd: root })
    const started = performance.now()
    process.kill('SIGTERM', 200)
    const exit = await process.done
    expect(exit.signal).toBe('SIGKILL')
    expect(performance.now() - started).toBeLessThan(5_000)
  })

  it('keeps 400 concurrent requests and two processes apart', async () => {
    const { channel, root } = local()
    await Promise.all(
      Array.from({ length: 200 }, (_, index) => channel.request('write', { path: join(root, `f${index}`), data: b64(`v${index}`), intent: { kind: 'any' } })),
    )
    const reads = await Promise.all(Array.from({ length: 200 }, (_, index) => channel.request('read', { path: join(root, `f${index}`) })))
    expect(reads.every((read, index) => text(read.data) === `v${index}`)).toBe(true)
    const [a, b] = await Promise.all([
      collect(channel, ['sh', '-c', 'for i in 1 2 3; do echo A$i; done'], root),
      collect(channel, ['sh', '-c', 'for i in 1 2 3; do echo B$i; done'], root),
    ])
    expect(a.stdout).toBe('A1\nA2\nA3\n')
    expect(b.stdout).toBe('B1\nB2\nB3\n')
  })

  it('tunnels a TCP connection to a server listening on loopback in the sandbox, and reports a closed port', async () => {
    const { channel, root } = local()
    const server = await channel.spawn({
      argv: [
        process.execPath,
        '-e',
        "require('node:http').createServer((q,r)=>r.end('inside '+q.url)).listen(0,'127.0.0.1',function(){console.log(this.address().port)})",
      ],
      cwd: root,
    })
    const port = await new Promise<number>(resolve => server.stdout.once('data', (chunk: Buffer) => resolve(Number(chunk.toString().trim()))))
    const socket = await channel.connect(port)
    const reply = new Promise<string>(resolve => {
      let text = ''
      socket.on('data', (chunk: Buffer) => (text += chunk.toString()))
      socket.on('end', () => resolve(text))
    })
    socket.end('GET /hello HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n')
    expect(await reply).toMatch(/^HTTP\/1\.1 200[\s\S]*inside \/hello$/u)
    server.kill('SIGKILL')
    const refused = await channel.connect(1)
    await expect(new Promise((_, reject) => refused.on('error', reject))).rejects.toMatchObject({ code: 'GUEST_CONNECTION_FAILED' })
  })

  it('fails pending requests and ends the agent when the channel closes', async () => {
    const root = scratch()
    const guest = GuestLauncher.startLocal({ root })
    await guest.channel.hello
    const running = await guest.channel.spawn({ argv: ['sleep', '30'], cwd: root })
    const exited = new Promise(resolve => guest.process.once('exit', resolve))
    await guest.channel.close()
    await exited
    await expect(running.done).resolves.toMatchObject({ exitCode: null })
    expect(await codeOf(guest.channel.request('ping', {}))).toBe('GUEST_CLOSED')
  })
})

describe('the channel', () => {
  it('keeps output that arrives in the same chunk as the spawn answer', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const channel = new GuestChannel({ input, output })
    input.on('data', (chunk: Buffer) => {
      const request = decodeJsonSafe(Schema.Struct({ id: Schema.Number, op: Schema.String }), chunk.toString().trim())
      if (request._tag === 'Failure' || request.success.op !== 'spawn') return
      // One write: the answer, the first output and the exit, as a fast process produces them.
      output.write(
        `${JSON.stringify({ t: 'res', id: request.success.id, ok: true, r: { p: 7 } })}\n${JSON.stringify({ t: 'out', p: 7, f: 1, d: b64('early') })}\n${JSON.stringify({ t: 'exit', p: 7, code: 0, signal: null })}\n`,
      )
    })
    const process = await channel.spawn({ argv: ['true'], cwd: '/' })
    const stdout = new Promise<string>(resolve => {
      let text = ''
      process.stdout.on('data', (chunk: Buffer) => (text += chunk.toString()))
      process.stdout.on('end', () => resolve(text))
    })
    await expect(process.done).resolves.toEqual({ exitCode: 0, signal: null })
    expect(await stdout).toBe('early')
  })
})

const dockerReady = spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0
const IMAGE = process.env['SANDBOX_GUEST_TEST_IMAGE'] ?? 'node:22-alpine'
const imageReady = dockerReady && spawnSync('docker', ['image', 'inspect', IMAGE], { stdio: 'ignore' }).status === 0

describe.skipIf(!imageReady)('the guest agent in a hardened container', () => {
  it('serves the same operations with no network, as a non-root user, at the host path of the workspace', async () => {
    const root = '/sandbox-test/workspace'
    const child = spawn(
      'docker',
      [
        'run',
        '-i',
        '--rm',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges',
        '--read-only',
        '--network',
        'none',
        '--pids-limit',
        '128',
        '--memory',
        '256m',
        '--user',
        '1000:1000',
        '--tmpfs',
        `${root}:uid=1000,gid=1000,size=16m`,
        '--tmpfs',
        '/tmp:size=16m',
        '--workdir',
        root,
        IMAGE,
        ...GuestLauncher.command({ root }),
      ],
      { stdio: ['pipe', 'pipe', 'inherit'] },
    )
    const guest = GuestLauncher.attach(child)
    started.push(guest)
    const hello = await guest.channel.hello
    expect(hello).toMatchObject({ uid: 1000, root, confine: false })
    await guest.channel.request('write', { path: `${root}/a.txt`, data: b64('in the box'), intent: { kind: 'createIfAbsent' } })
    const shell = await collect(
      guest.channel,
      [
        'sh',
        '-c',
        "cat a.txt; echo; id -u; node -e \"require('node:net').connect(443,'1.1.1.1').on('error',e=>console.log(e.code)).on('connect',()=>console.log('CONNECTED'))\"",
      ],
      root,
    )
    expect(shell.stdout).toMatch(/^in the box\n1000\nE\w+\n$/)
  })
})
