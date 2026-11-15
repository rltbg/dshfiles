import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { SubprocessError, type SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { GuestLauncher, type StartedGuest } from '@dshfiles/sandbox-guest/launch'
import { afterEach, describe, expect, it } from 'vitest'
import { apply } from '../src/host.ts'

/** The stock policy service's surface the sandboxed filesystem reads. */
class FakePolicy extends Service {
  readonly defaultMode: SandboxMode = 'workspace-write'

  constructor(ctx: Context) {
    super(ctx, 'sandboxPolicy')
  }

  resolve(): SandboxExecutionPolicy {
    return { mode: 'workspace-write', workspaceRoot: process.cwd() }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    sandboxPolicy: FakePolicy
  }
}

const contexts: Context[] = []
const guests: StartedGuest[] = []
const folders: string[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(guests.splice(0).map(guest => guest.channel.close()))
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

const scratch = (): string => {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'sandbox-seams-')))
  folders.push(folder)
  return folder
}

/** A Host with the routed providers, one sandbox served by a confined local guest agent, and one plain folder. */
const setup = async () => {
  const ctx = new Context()
  contexts.push(ctx)
  ctx.plugin(FakePolicy)
  await ctx.plugin({ name: 'sandbox-seams-test', apply })
  const workspace = scratch()
  const host = scratch()
  const guest = GuestLauncher.startLocal({ root: workspace })
  guests.push(guest)
  await guest.channel.hello
  const unregister = ctx.sandboxRoutes.register({ id: 'sb1', root: workspace, channel: guest.channel })
  return { ctx, fs: ctx.fs, subprocess: ctx.subprocess, sandbox: ctx.sandbox, workspace, host, guest, unregister }
}

const codeOf = (promise: Promise<unknown>): Promise<string> =>
  promise.then(
    () => 'resolved',
    (error: unknown) => (error instanceof FsError || error instanceof SubprocessError ? error.code : String(error)),
  )

const bash = (command: string, cwd: string, extra: Partial<SubprocessSpawnSpec> = {}): SubprocessSpawnSpec => ({
  argv: ['bash', '-c', command],
  cwd,
  stdio: { stdin: 'ignore', stdout: { maxBytes: 64_000, spill: { maxBytes: 1_000_000 } }, stderr: { maxBytes: 64_000 } },
  graceMs: 200,
  ...extra,
})

const policy = (mode: SandboxMode, workspaceRoot: string): SandboxExecutionPolicy => ({ mode, workspaceRoot })

describe('the routed filesystem', () => {
  it('resolves a sandbox path to a routed target and leaves a Host path to the stock provider', async () => {
    const { fs, workspace, host } = await setup()
    const routed = await fs.resolve('src/a.txt', { cwd: workspace })
    expect(String(routed.targetKey)).toBe(`sandbox:sb1:${join(workspace, 'src', 'a.txt')}`)
    expect(fs.processPath(routed)).toBe(join(workspace, 'src', 'a.txt'))
    const local = await fs.resolve('b.txt', { cwd: host })
    expect(String(local.targetKey)).toBe(join(host, 'b.txt'))
    const root = await fs.resolve(workspace, { cwd: workspace })
    expect(fs.contains(root, routed)).toBe(true)
    expect(fs.contains(root, local)).toBe(false)
  })

  it('refuses a path across a sandbox boundary in either direction, and the Host home from a sandbox', async () => {
    const { fs, workspace, host } = await setup()
    expect(await codeOf(fs.resolve(join(host, 'x'), { cwd: workspace }))).toBe('FS_SANDBOX_DENIED')
    expect(await codeOf(fs.resolve(join(workspace, 'x'), { cwd: host }))).toBe('FS_SANDBOX_DENIED')
    expect(await codeOf(fs.resolve('~/.ssh/id_ed25519', { cwd: workspace }))).toBe('FS_SANDBOX_DENIED')
    expect(await codeOf(fs.lstat(join(host, 'x'), { cwd: workspace }))).toBe('FS_SANDBOX_DENIED')
  })

  it('writes, reads, lists, edits, patches, moves and deletes inside the sandbox with version guards', async () => {
    const { fs, workspace } = await setup()
    const target = await fs.resolve('notes/a.txt', { cwd: workspace })
    const created = await fs.writeText(target, 'one\ntwo\n', { kind: 'createIfAbsent' })
    expect(created).toMatchObject({ operation: 'create', before: null, after: 'one\ntwo\n' })
    expect(await fs.readText(target)).toBe('one\ntwo\n')
    expect(await fs.stat(target)).toMatchObject({ type: 'file', size: 8, version: created.version })
    const listed = await fs.listDir(await fs.resolve('notes', { cwd: workspace }))
    expect(listed.map(entry => [entry.name, entry.type, String(entry.target.targetKey)])).toEqual([['a.txt', 'file', String(target.targetKey)]])

    const edited = await fs.editText(target, { oldString: 'two', newString: 'deux', replaceAll: false }, { version: created.version })
    expect(edited).toMatchObject({ before: 'one\ntwo\n', after: 'one\ndeux\n' })
    expect(await codeOf(fs.editText(target, { oldString: 'one', newString: '1', replaceAll: false }, { version: created.version }))).toBe('FS_STALE_VERSION')
    expect(await codeOf(fs.editText(target, { oldString: 'absent', newString: 'x', replaceAll: false }))).toBe('FS_EDIT_NOT_FOUND')
    expect(await codeOf(fs.writeText(target, 'x', { kind: 'createIfAbsent' }))).toBe('FS_NOT_OBSERVED')

    const patched = await fs.patchText(target, [{ lineNumber: 1, oldLines: ['one', 'deux'], newLines: ['one', 'two'], isEndOfFile: false }])
    expect(patched.after).toBe('one\ntwo\n')

    const moved = await fs.moveFile(target, await fs.resolve('notes/b.txt', { cwd: workspace }), {})
    expect(moved).toMatchObject({ sourceDeleted: true, destination: { operation: 'create', after: 'one\ntwo\n' } })
    expect(await fs.stat(target)).toBeUndefined()
    const moveTarget = await fs.resolve('notes/b.txt', { cwd: workspace })
    await expect(fs.deleteFile(moveTarget)).resolves.toEqual({ before: 'one\ntwo\n' })
    expect(await fs.stat(moveTarget)).toBeUndefined()
  })

  it('keeps CRLF line endings on edit and refuses binary, oversized and stale content as the local provider does', async () => {
    const { fs, workspace } = await setup()
    writeFileSync(join(workspace, 'crlf.txt'), 'a\r\nb\r\n')
    const crlf = await fs.resolve('crlf.txt', { cwd: workspace })
    await fs.editText(crlf, { oldString: 'b', newString: 'c', replaceAll: false })
    expect(readFileSync(join(workspace, 'crlf.txt'), 'utf8')).toBe('a\r\nc\r\n')

    writeFileSync(join(workspace, 'bin'), Buffer.from([0x41, 0, 0x42]))
    const binary = await fs.resolve('bin', { cwd: workspace })
    expect(await codeOf(fs.readText(binary))).toBe('FS_NOT_TEXT')
    expect(Buffer.from(await fs.readBytes(binary, undefined, 10))).toEqual(Buffer.from([0x41, 0, 0x42]))
    expect(await codeOf(fs.readBytes(binary, undefined, 2))).toBe('FS_TOO_LARGE')
    expect(Buffer.from(await fs.readByteRange(binary, { offset: 2, length: 5 }))).toEqual(Buffer.from([0x42]))

    const stale = await fs.resolve('stale.txt', { cwd: workspace })
    const first = await fs.writeText(stale, 'v1')
    writeFileSync(join(workspace, 'stale.txt'), 'changed in the sandbox')
    expect(await codeOf(fs.writeText(stale, 'v2', { kind: 'replaceIfVersion', version: first.version }))).toBe('FS_STALE_VERSION')
  })

  it('fences writes by the per-call policy inside the sandbox', async () => {
    const { fs, workspace } = await setup()
    const target = await fs.resolve('a.txt', { cwd: workspace })
    expect(await codeOf(fs.writeText(target, 'x', undefined, undefined, policy('read-only', workspace)))).toBe('FS_SANDBOX_DENIED')
    await expect(fs.writeText(target, 'x', undefined, undefined, policy('workspace-write', workspace))).resolves.toMatchObject({ operation: 'create' })
    expect(await codeOf(fs.deleteFile(target, undefined, undefined, policy('read-only', workspace)))).toBe('FS_SANDBOX_DENIED')
  })

  it('reports a sandbox that is gone with a way to start it again', async () => {
    const { fs, workspace, unregister } = await setup()
    const target = await fs.resolve('a.txt', { cwd: workspace })
    unregister()
    await expect(fs.readText(target)).rejects.toMatchObject({ code: 'FS_IO_ERROR', message: expect.stringMatching(/not running\. Start it/) })
  })
})

describe('the routed subprocess runtime', () => {
  it('runs a sandboxed command through the guest agent and a Host command locally', async () => {
    const { subprocess, workspace, host, guest } = await setup()
    const inside = subprocess.spawn(bash('echo "$PPID $FOO"; pwd', workspace, { env: { FOO: 'bar', PATH: '/nowhere' } }))
    await expect(inside.done).resolves.toMatchObject({ exitCode: 0 })
    expect(inside.collected.stdout?.readFrom(0).text).toBe(`${guest.process.pid} bar\n${workspace}\n`)
    const outside = subprocess.spawn(bash('echo "$PPID"', host))
    await expect(outside.done).resolves.toMatchObject({ exitCode: 0 })
    expect(outside.collected.stdout?.readFrom(0).text.trim()).not.toBe(String(guest.process.pid))
  })

  it('feeds stdin, reports exit codes and stderr, and resolves a Host-resolved program in the sandbox', async () => {
    const { subprocess, workspace } = await setup()
    const fed = subprocess.spawn({
      ...bash('cat; echo err >&2; exit 4', workspace),
      stdio: { stdin: { data: 'in\n' }, stdout: { maxBytes: 1000 }, stderr: { maxBytes: 1000 } },
    })
    await expect(fed.done).resolves.toMatchObject({ exitCode: 4 })
    expect(fed.collected.stdout?.readFrom(0).text).toBe('in\n')
    expect(fed.collected.stderr?.readFrom(0).text).toBe('err\n')
    const absolute = subprocess.spawn({ ...bash('', workspace), argv: ['/definitely/host/only/echo', 'via', 'basename'] })
    await expect(absolute.done).resolves.toMatchObject({ exitCode: 0 })
    expect(absolute.collected.stdout?.readFrom(0).text).toBe('via basename\n')
  })

  it('streams a pipe-mode process and stops its whole group on terminate and on abort', async () => {
    const { subprocess, workspace } = await setup()
    const piped = subprocess.spawn({ ...bash('read line; echo "got $line"', workspace), stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' } })
    let out = ''
    piped.stdout?.on('data', (chunk: Buffer) => (out += chunk.toString()))
    piped.stdin?.end('hello\n')
    await piped.done
    expect(out).toBe('got hello\n')

    const long = subprocess.spawn(bash('sleep 30 & sleep 30; wait', workspace))
    const started = performance.now()
    long.terminate()
    await long.done
    expect(performance.now() - started).toBeLessThan(5_000)
    await expect(long.waitForExit()).resolves.toBe(true)

    const stubborn = subprocess.spawn(bash("trap '' TERM; sleep 30", workspace))
    await new Promise(resolve => setTimeout(resolve, 100))
    stubborn.terminate()
    await expect(stubborn.done).resolves.toMatchObject({ signal: 'SIGKILL' })

    const controller = new AbortController()
    const aborted = subprocess.spawn(bash('sleep 30', workspace, { signal: controller.signal }))
    controller.abort()
    const exit = await aborted.done
    expect(exit.exitCode).not.toBe(0)
  })

  it('refuses a terminal and a control channel in a sandbox with a way forward', async () => {
    const { subprocess, workspace } = await setup()
    expect(await codeOf(subprocess.spawnTerminal({ argv: ['bash'], cwd: workspace, rows: 24, cols: 80, terminalType: 'xterm-256color', graceMs: 200 }))).toBe(
      'SUBPROCESS_PTY_UNAVAILABLE',
    )
    expect(() => subprocess.spawn({ ...bash('true', workspace), stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', control: 'pipe' } })).toThrow(
      /control channel is not available/,
    )
  })

  it('fails a process with a recovery when its sandbox channel has closed', async () => {
    const { subprocess, workspace, guest } = await setup()
    await guest.channel.close()
    await expect(subprocess.spawn(bash('true', workspace)).done).rejects.toMatchObject({
      code: 'SUBPROCESS_SPAWN_FAILED',
      message: expect.stringMatching(/Start the sandbox again/),
    })
  })
})

describe('the routed sandbox provider', () => {
  it('passes a sandboxed workspace command through unchanged and sends others to the local runner chain', async () => {
    const { sandbox, workspace, host } = await setup()
    const argv = ['bash', '-c', 'echo hi']
    await expect(sandbox.confine(argv, { mode: 'workspace-write', workspaceRoot: workspace })).resolves.toEqual({
      argv,
      enforcement: 'full',
      denialSignatures: [],
      runnerFailureRules: [],
    })
    await expect(sandbox.confine(argv, { mode: 'read-only', workspaceRoot: workspace })).resolves.toMatchObject({ enforcement: 'partial' })
    // The stock chain either wraps the argv in a runner or fails closed; it never passes it through.
    const local = await sandbox.confine(argv, { mode: 'workspace-write', workspaceRoot: host }).then(
      confined => confined.argv,
      (error: unknown) => (error instanceof Error ? error.name : 'error'),
    )
    expect(local).not.toEqual(argv)
  })
})

describe('the route registry', () => {
  it('refuses overlapping roots and forgets a route when it is unregistered', async () => {
    const { ctx, workspace, guest, unregister } = await setup()
    const inner = join(workspace, 'inner')
    mkdirSync(inner)
    expect(() => ctx.sandboxRoutes.register({ id: 'sb2', root: inner, channel: guest.channel })).toThrow(/already routes/)
    expect(ctx.sandboxRoutes.forPath(join(workspace, 'a', 'b'))?.id).toBe('sb1')
    unregister()
    expect(ctx.sandboxRoutes.forPath(workspace)).toBeUndefined()
    expect(ctx.sandboxRoutes.list()).toEqual([])
  })
})
