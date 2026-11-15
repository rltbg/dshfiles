import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-fs'
import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomainPlugin from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import WorkspaceRegistryPlugin from '@deepseek-ai/dsh-workspace'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { createHostApiClient } from '@dshfiles/dshx/host'
import { createTestHost, mountPlugin, type TestHost } from '@dshfiles/dshx/testing'
import { apply as seams } from '@dshfiles/sandbox-seams'
import { afterEach, describe, expect, it } from 'vitest'
import { sandboxesApi } from '../src/api.ts'
import sandboxesPlugin from '../src/host.ts'
import type { SandboxesSettingsValue } from '../src/settings.ts'

/** The stock policy service's surface the routed filesystem reads. */
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

const folders: string[] = []
const hosts: TestHost[] = []

afterEach(async () => {
  await Promise.all(hosts.splice(0).map(host => host.dispose()))
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

const scratch = (): string => {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'sandboxes-')))
  folders.push(folder)
  return folder
}

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

/** A committed repository with a tracked file. */
const repository = (): string => {
  const repo = join(scratch(), 'project')
  execFileSync('git', ['init', '-q', '-b', 'main', repo])
  git(repo, 'config', 'user.name', 'Test')
  git(repo, 'config', 'user.email', 'test@example.com')
  writeFileSync(join(repo, 'README.md'), 'hello\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'base')
  return repo
}

type Settings = Partial<SandboxesSettingsValue>

/** A test Host with storage, the workspace registry, the routed seams and the sandboxes plugin over a scratch DSH home. */
const start = async (settings: Settings, home = scratch()) => {
  process.env['DSH_HOME'] = home
  const host = await createTestHost()
  hosts.push(host)
  await host.ctx.plugin(Storage)
  await host.ctx.plugin(StorageJson, { root: join(home, 'storage') })
  await host.ctx.plugin(StorageDomainPlugin, { backend: 'json' })
  await host.ctx.plugin(JsonlPersistence, { root: join(home, 'sessions') })
  await host.ctx.plugin(WorkspaceRegistryPlugin)
  host.ctx.plugin(FakePolicy)
  await host.ctx.plugin({ name: 'seams', apply: seams })
  host.ctx.provide('settings', {
    configure: () => () => undefined,
    describe: () => [{ ns: 'dshfiles-sandboxes', value: settings, revision: 1 }],
    update: async () => undefined,
    replace: async () => undefined,
  })
  const mounted = await mountPlugin(host, sandboxesPlugin, { packageId: '@dshfiles/sandboxes' })
  const api = createHostApiClient(host.ctx, sandboxesApi, '@dshfiles/sandboxes-test')
  return { host, mounted, api, home }
}

const bash = (command: string, cwd: string): SubprocessSpawnSpec => ({
  argv: ['bash', '-c', command],
  cwd,
  stdio: { stdin: 'ignore', stdout: { maxBytes: 64_000 }, stderr: { maxBytes: 64_000 } },
  graceMs: 500,
})

const run = async (host: TestHost, command: string, cwd: string) => {
  const handle = host.ctx.subprocess.spawn(bash(command, cwd))
  const exit = await handle.done
  return { exitCode: exit.exitCode, stdout: handle.collected.stdout?.readFrom(0).text ?? '', stderr: handle.collected.stderr?.readFrom(0).text ?? '' }
}

const eventually = async (check: () => Promise<boolean>, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error('condition not met in time')
}

describe('sandboxes on the directory provider', () => {
  it('creates a sandbox from a git repository, routes its workspace and registers it as a project', async () => {
    const { host, api } = await start({ provider: 'directory' })
    const repo = repository()
    const sandbox = await api.create({ path: repo })
    expect(sandbox).toMatchObject({ state: 'ready', running: true, provider: 'directory', repoRoot: repo, title: 'Sandbox · project' })
    expect(sandbox.baseCommit).toBe(git(repo, 'rev-parse', 'HEAD').trim())
    expect(host.ctx.sandboxRoutes.get(sandbox.id)?.root).toBe(sandbox.workspace)
    const target = await host.ctx.fs.resolve('README.md', { cwd: sandbox.workspace })
    expect(String(target.targetKey)).toMatch(/^sandbox:/u)
    expect(await host.ctx.fs.readText(target)).toBe('hello\n')
    expect(sandbox.workspaceId).not.toBeNull()
    expect((await api.list({})).sandboxes.map(listed => listed.id)).toEqual([sandbox.id])
  })

  it('copies the changes back after a turn and on export, without touching the project checkout', async () => {
    const { host, api } = await start({ provider: 'directory' })
    const repo = repository()
    const sandbox = await api.create({ path: repo })
    const target = await host.ctx.fs.resolve('src/new.txt', { cwd: sandbox.workspace })
    await host.ctx.fs.writeText(target, 'from the sandbox\n')
    expect((await run(host, 'echo appended >> README.md && git status --porcelain', sandbox.workspace)).exitCode).toBe(0)

    host.ctx.emit('agent/status', { agent: { session: { header: { cwd: sandbox.workspace } } }, status: 'idle' } as never)
    await eventually(async () => (await api.inspect({ id: sandbox.id })).lastSync !== null)
    const synced = await api.inspect({ id: sandbox.id })
    expect(synced.lastSync?.worktree).toBe('created')
    expect(readFileSync(join(sandbox.changes, 'src', 'new.txt'), 'utf8')).toBe('from the sandbox\n')
    expect(readFileSync(join(sandbox.changes, 'README.md'), 'utf8')).toBe('hello\nappended\n')
    expect(git(repo, 'status', '--porcelain')).toBe('')
    expect(readFileSync(join(repo, 'README.md'), 'utf8')).toBe('hello\n')

    // An edit of the user's in the changes worktree is never overwritten.
    writeFileSync(join(sandbox.changes, 'mine.txt'), 'user edit\n')
    await expect(api.export({ id: sandbox.id })).resolves.toMatchObject({ worktree: 'held' })
    rmSync(join(sandbox.changes, 'mine.txt'))
    await host.ctx.fs.writeText(await host.ctx.fs.resolve('second.txt', { cwd: sandbox.workspace }), 'two\n')
    await expect(api.export({ id: sandbox.id })).resolves.toMatchObject({ worktree: 'updated' })
    expect(readFileSync(join(sandbox.changes, 'second.txt'), 'utf8')).toBe('two\n')
  })

  it('stops and starts a sandbox with its files kept, and refuses a request that does not fit its state', async () => {
    const { host, api } = await start({ provider: 'directory', syncAfterTurn: false })
    const sandbox = await api.create({ path: repository() })
    await host.ctx.fs.writeText(await host.ctx.fs.resolve('kept.txt', { cwd: sandbox.workspace }), 'kept\n')
    const stopped = await api.stop({ id: sandbox.id })
    expect(stopped).toMatchObject({ state: 'stopped', running: false })
    expect(stopped.stoppedAt).not.toBeNull()
    expect(host.ctx.sandboxRoutes.get(sandbox.id)).toBeUndefined()
    await expect(api.stop({ id: sandbox.id })).rejects.toMatchObject({ remoteCode: 'sandbox-state-conflict' })
    await expect(api.start({ id: sandbox.id })).resolves.toMatchObject({ state: 'ready', running: true, stoppedAt: null })
    expect(await host.ctx.fs.readText(await host.ctx.fs.resolve('kept.txt', { cwd: sandbox.workspace }))).toBe('kept\n')
    await expect(api.start({ id: sandbox.id })).rejects.toMatchObject({ remoteCode: 'sandbox-state-conflict' })
  })

  it('destroys only with confirmDestroy, keeping the last snapshot in the project repository', async () => {
    const { host, api } = await start({ provider: 'directory' })
    const repo = repository()
    const sandbox = await api.create({ path: repo })
    await host.ctx.fs.writeText(await host.ctx.fs.resolve('work.txt', { cwd: sandbox.workspace }), 'work\n')
    await expect(api.destroy({ id: sandbox.id, confirmDestroy: false })).rejects.toMatchObject({ remoteCode: 'sandbox-confirmation-required' })
    const destroyed = await api.destroy({ id: sandbox.id, confirmDestroy: true })
    expect(destroyed).toMatchObject({ id: sandbox.id, changesKept: false, snapshotRef: `refs/dshfiles/sandbox/${sandbox.id}` })
    expect(git(repo, 'show', `${destroyed.snapshotRef}:work.txt`)).toBe('work\n')
    expect(existsSync(sandbox.workspace)).toBe(false)
    expect(existsSync(sandbox.changes)).toBe(false)
    expect((await api.list({})).sandboxes).toEqual([])
    await expect(api.inspect({ id: sandbox.id })).rejects.toMatchObject({ remoteCode: 'sandbox-not-found' })
  })

  it('destroys a sandbox at stop when its retention is zero', async () => {
    const { api } = await start({ provider: 'directory', syncAfterTurn: false })
    const sandbox = await api.create({ path: repository() })
    await expect(api.setRetention({ id: sandbox.id, stoppedHours: 0 })).resolves.toMatchObject({ stoppedHours: 0 })
    await api.stop({ id: sandbox.id })
    expect((await api.list({})).sandboxes).toEqual([])
  })

  it('marks what was running as stopped when the plugin comes back, and starts it again', async () => {
    const home = scratch()
    const first = await start({ provider: 'directory', syncAfterTurn: false }, home)
    const sandbox = await first.api.create({ path: repository() })
    await first.mounted.dispose()
    const second = await start({ provider: 'directory', syncAfterTurn: false }, home)
    await expect(second.api.inspect({ id: sandbox.id })).resolves.toMatchObject({ state: 'stopped', running: false })
    await expect(second.api.start({ id: sandbox.id })).resolves.toMatchObject({ state: 'ready', running: true })
  })

  it('refuses a folder outside git, and more sandboxes than the limit, with a way forward', async () => {
    const { api } = await start({ provider: 'directory', maxSandboxes: 1 })
    await expect(api.create({ path: scratch() })).rejects.toMatchObject({ remoteCode: 'sandbox-project-unsupported' })
    await api.create({ path: repository() })
    await expect(api.create({ path: repository() })).rejects.toMatchObject({
      remoteCode: 'sandbox-state-conflict',
      message: expect.stringMatching(/limit of 1/u),
    })
  })

  it('reports each provider with its readiness and the step that fixes it', async () => {
    const { api } = await start({ provider: 'directory', containerEngine: 'podman' })
    const { providers } = await api.doctor({})
    expect(providers.find(provider => provider.provider === 'directory')).toMatchObject({ ready: true, isolation: 'none' })
    const container = providers.find(provider => provider.provider === 'container')
    expect(container?.isolation).toBe('container')
    if (container?.ready === false) expect(container.fix).toBeDefined()
  })
})

const IMAGE = process.env['SANDBOXES_TEST_IMAGE'] ?? 'dshfiles-sandbox:1'
const dockerReady = spawnSync('docker', ['image', 'inspect', IMAGE], { stdio: 'ignore' }).status === 0

describe.skipIf(!dockerReady)('sandboxes in a hardened container', () => {
  it('runs a thread workspace in a container with no network, as a non-root user, and copies its changes back', async () => {
    const { host, api } = await start({ provider: 'container', containerEngine: 'docker', image: IMAGE })
    const repo = repository()
    const started = performance.now()
    const sandbox = await api.create({ path: repo })
    const createMs = performance.now() - started
    expect(sandbox).toMatchObject({ state: 'ready', provider: 'container' })
    const inside = await run(
      host,
      "id -u; cat README.md; node -e \"require('node:net').connect(443,'1.1.1.1').on('error',e=>console.log(e.code)).on('connect',()=>console.log('CONNECTED'))\"",
      sandbox.workspace,
    )
    expect(inside.stdout).toMatch(/^1000\nhello\nE\w+\n$/u)
    // The Host folder stays an empty anchor: the files live in the container's volume.
    expect(existsSync(join(sandbox.workspace, 'README.md'))).toBe(false)
    await host.ctx.fs.writeText(await host.ctx.fs.resolve('from-container.txt', { cwd: sandbox.workspace }), 'boxed\n')
    await expect(api.export({ id: sandbox.id })).resolves.toMatchObject({ worktree: 'created' })
    expect(readFileSync(join(sandbox.changes, 'from-container.txt'), 'utf8')).toBe('boxed\n')
    await api.stop({ id: sandbox.id })
    const restarted = performance.now()
    await api.start({ id: sandbox.id })
    const startMs = performance.now() - restarted
    expect(await host.ctx.fs.readText(await host.ctx.fs.resolve('from-container.txt', { cwd: sandbox.workspace }))).toBe('boxed\n')
    await api.destroy({ id: sandbox.id, confirmDestroy: true })
    expect(spawnSync('docker', ['volume', 'inspect', `dshfiles-sandbox-${sandbox.id}`], { stdio: 'ignore' }).status).not.toBe(0)
    console.log(`container sandbox: create to ready ${Math.round(createMs)} ms, warm start ${Math.round(startMs)} ms`)
  }, 120_000)
})
