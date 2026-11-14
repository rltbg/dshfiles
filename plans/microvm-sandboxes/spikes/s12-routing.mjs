// Spike S12 (architecture B): one ctx.fs provider and one ctx.subprocess provider, built on DSH core's own
// abstract classes, route each call to a per-thread container by the thread's working directory.
// Usage: node spike.mjs <dshfiles checkout>
import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const workspace = process.argv[2]
const requireFrom = createRequire(join(workspace, 'plugins/@dshfiles/subprocess-local/package.json'))
const coreRequire = createRequire(requireFrom.resolve('@deepseek-ai/dsh-subprocess'))
const load = name => import(pathToFileURL(coreRequire.resolve(name)).href)
const { Context } = await load('@deepseek-ai/cordis')
const { SubprocessRuntime } = await load('@deepseek-ai/dsh-subprocess')
const fsRequire = createRequire(join(workspace, 'plugins/@dshfiles/tool-fs/package.json'))
const { FileSystem, FsTargetKey } = await import(pathToFileURL(fsRequire.resolve('@deepseek-ai/dsh-fs')).href)

// thread working directory (as the Host and the UI see it) → the container that owns it
const sandboxes = new Map()
const route = path => {
  for (const [root, container] of sandboxes) {
    if (path === root || path.startsWith(`${root}/`)) return { container, guestPath: `/workspace${path.slice(root.length)}` }
  }
  throw Object.assign(new Error(`${path} is outside every sandbox`), { code: 'SANDBOX_NO_ROUTE' })
}
const dexec = (container, argv, input) =>
  new Promise((resolve, reject) => {
    const child = spawn('docker', ['exec', '-i', container, ...argv])
    const out = []
    const err = []
    child.stdout.on('data', c => out.push(c))
    child.stderr.on('data', c => err.push(c))
    child.on('error', reject)
    child.on('close', code => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(Buffer.concat(err).toString().trim() || `exit ${code}`))))
    child.stdin.end(input ?? '')
  })

const partsOf = target => {
  const [container, ...rest] = String(target.targetKey).split(':')
  return { container, guestPath: rest.join(':') }
}

class RoutedFileSystem extends FileSystem {
  async resolve(path, opts) {
    const absolute = path.startsWith('/') ? join(path) : join(opts?.cwd ?? '/', path)
    const { container, guestPath } = route(absolute)
    // The working directory names the thread that asks. Its paths must stay inside its own sandbox.
    if (opts?.cwd !== undefined && route(opts.cwd).container !== container) {
      throw Object.assign(new Error(`${absolute} belongs to another sandbox`), { code: 'SANDBOX_CROSS_ROUTE' })
    }
    return { targetKey: FsTargetKey(`${container}:${guestPath}`), displayPath: absolute }
  }
  processPath(target) {
    return partsOf(target).guestPath
  }
  fileUrl(target) {
    return `sandbox://${String(target.targetKey)}`
  }
  contains(parent, child) {
    const a = partsOf(parent)
    const b = partsOf(child)
    return a.container === b.container && (b.guestPath === a.guestPath || b.guestPath.startsWith(`${a.guestPath}/`))
  }
  async stat(target) {
    const { container, guestPath } = partsOf(target)
    try {
      const [size, kind] = (await dexec(container, ['stat', '-c', '%s %F', guestPath])).toString().trim().split(/ (.*)/)
      return { size: Number(size), kind }
    } catch {
      return undefined
    }
  }
  async readText(target) {
    const { container, guestPath } = partsOf(target)
    return (await dexec(container, ['cat', guestPath])).toString()
  }
  async listDir(target) {
    const { container, guestPath } = partsOf(target)
    return (await dexec(container, ['ls', '-1A', guestPath])).toString().split('\n').filter(Boolean).map(name => ({ name }))
  }
  async writeText(target, content) {
    const { container, guestPath } = partsOf(target)
    await dexec(container, ['sh', '-c', 'mkdir -p "$(dirname "$1")" && cat > "$1.tmp" && mv "$1.tmp" "$1"', 'sh', guestPath], content)
    return { written: true }
  }
  lstat() { throw new Error('not in the spike') }
  streamText() { throw new Error('not in the spike') }
  readBytes() { throw new Error('not in the spike') }
  readByteRange() { throw new Error('not in the spike') }
  editText() { throw new Error('not in the spike') }
}

class RoutedSubprocess extends SubprocessRuntime {
  // No working directory here, so the name is resolved in the guest when the command is spawned.
  async resolveExecutable(command) {
    return command
  }
  async terminalEnvironment() {
    return { platform: 'posix', defaultShell: '/bin/sh' }
  }
  spawn(spec) {
    const { container, guestPath } = route(spec.cwd)
    const env = Object.entries(spec.env ?? {}).flatMap(([key, value]) => (value === undefined ? [] : ['-e', `${key}=${value}`]))
    const child = spawn('docker', ['exec', '-i', '-w', guestPath, ...env, container, ...spec.argv], { stdio: ['pipe', 'pipe', 'pipe'] })
    const done = new Promise((resolve, reject) => {
      child.on('error', reject)
      child.on('close', (exitCode, signal) => resolve({ exitCode, signal }))
    })
    spec.signal?.addEventListener('abort', () => child.kill('SIGTERM'))
    return {
      stdin: child.stdin,
      stdout: child.stdout,
      stderr: child.stderr,
      control: undefined,
      collected: {},
      done,
      terminate: () => child.kill('SIGTERM'),
      waitForExit: () => done.then(() => true),
    }
  }
  async spawnTerminal() { throw new Error('not in the spike') }
}

const collect = async handle => {
  let text = ''
  handle.stdout.on('data', c => (text += c))
  handle.stdin.end()
  const outcome = await handle.done
  return { ...outcome, text: text.trim() }
}

const hardened = ['--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--read-only', '--network', 'none', '--pids-limit', '128',
  '--memory', '256m', '--user', '1000:1000', '--tmpfs', '/workspace:uid=1000,gid=1000,size=64m', '--tmpfs', '/tmp:size=16m']
const names = ['s12-a', 's12-b']
const results = []
const check = (name, pass, detail) => results.push({ name, pass, detail })
await run('docker', ['rm', '-f', ...names]).catch(() => {})
try {
  const startedAt = performance.now()
  for (const name of names) await run('docker', ['run', '-d', '--name', name, ...hardened, 'node:22-alpine', 'sleep', '600'])
  const startMs = Math.round((performance.now() - startedAt) / names.length)
  // The roots are how the Host names each thread's folder. They do not exist on the host.
  const rootA = '/sandboxes/thread-a/workspace'
  const rootB = '/sandboxes/thread-b/workspace'
  sandboxes.set(rootA, 's12-a')
  sandboxes.set(rootB, 's12-b')

  const ctx = new Context()
  await ctx.plugin(RoutedFileSystem)
  await ctx.plugin(RoutedSubprocess)
  check('providers mount as ctx.fs and ctx.subprocess', ctx.fs instanceof FileSystem && ctx.subprocess instanceof SubprocessRuntime, '')

  // Thread A writes a file through the file seam, then reads it through the process seam.
  const fileA = await ctx.fs.resolve('notes/secret.txt', { cwd: rootA })
  await ctx.fs.writeText(fileA, 'only-in-A\n')
  const catA = await collect(ctx.subprocess.spawn({ argv: ['cat', 'notes/secret.txt'], cwd: rootA, stdio: 'pipe', graceMs: 1000 }))
  check('A: a file written through ctx.fs is seen by a command spawned through ctx.subprocess', catA.text === 'only-in-A', catA.text)

  // Thread B, same relative path, must see nothing of A.
  const fileB = await ctx.fs.resolve('notes/secret.txt', { cwd: rootB })
  check('B: the same relative path is a different target', String(fileB.targetKey) !== String(fileA.targetKey), `${fileA.targetKey} vs ${fileB.targetKey}`)
  check('B: A\'s file does not exist', (await ctx.fs.stat(fileB)) === undefined, '')
  const lsB = await collect(ctx.subprocess.spawn({ argv: ['sh', '-c', 'ls -A /workspace | wc -l; cat /workspace/notes/secret.txt 2>&1; id -u; hostname'], cwd: rootB, stdio: 'pipe', graceMs: 1000 }))
  check('B: its workspace is empty, A\'s file is absent, it runs as uid 1000 in its own container', lsB.text.startsWith('0\n') && lsB.text.includes('No such file') && lsB.text.includes('\n1000\n'), lsB.text.replace(/\n/g, ' | '))

  check('the host has no such file', !existsSync(join(rootA, 'notes/secret.txt')) && !existsSync('/sandboxes'), '')
  const outside = await ctx.fs.resolve('/etc/passwd').then(() => 'resolved', error => error.code)
  check('a path outside every sandbox is refused', outside === 'SANDBOX_NO_ROUTE', outside)
  const escape = await ctx.fs.resolve('../../thread-b/workspace/x', { cwd: rootA }).then(() => 'resolved', error => error.code)
  check('".." from A into B\'s root is refused', escape === 'SANDBOX_CROSS_ROUTE', escape)
  const absolute = await ctx.fs.resolve(`${rootB}/notes/secret.txt`, { cwd: rootA }).then(() => 'resolved', error => error.code)
  check('an absolute path into B\'s root, asked from A, is refused', absolute === 'SANDBOX_CROSS_ROUTE', absolute)
  const spawnOutside = (() => { try { ctx.subprocess.spawn({ argv: ['true'], cwd: '/home', stdio: 'pipe', graceMs: 1 }); return 'spawned' } catch (error) { return error.code } })()
  check('a command with a working directory outside every sandbox is refused', spawnOutside === 'SANDBOX_NO_ROUTE', spawnOutside)

  // 20 interleaved operations per thread: no cross-talk.
  const timings = []
  const burst = (root, tag) =>
    Promise.all(Array.from({ length: 20 }, async (_, index) => {
      const at = performance.now()
      const target = await ctx.fs.resolve(`f${index}.txt`, { cwd: root })
      await ctx.fs.writeText(target, `${tag}-${index}`)
      const back = await ctx.fs.readText(target)
      timings.push(performance.now() - at)
      return back === `${tag}-${index}`
    }))
  const [burstA, burstB] = await Promise.all([burst(rootA, 'A'), burst(rootB, 'B')])
  const countA = await collect(ctx.subprocess.spawn({ argv: ['sh', '-c', 'cat f*.txt | tr -d "0-9-" | fold -w1 | sort -u | tr -d "\\n"'], cwd: rootA, stdio: 'pipe', graceMs: 1000 }))
  check('40 interleaved writes and reads: each thread reads back its own content only', burstA.every(Boolean) && burstB.every(Boolean) && countA.text === 'A', `A sees tags: ${countA.text}`)

  const exit = await collect(ctx.subprocess.spawn({ argv: ['sh', '-c', 'exit 7'], cwd: rootA, stdio: 'pipe', graceMs: 1000 }))
  check('exit codes come back', exit.exitCode === 7, `exitCode ${exit.exitCode}`)

  timings.sort((a, b) => a - b)
  console.log(JSON.stringify({ containerStartMs: startMs, opMsP50: Math.round(timings[20]), opMsMax: Math.round(timings.at(-1)), note: 'each op is 3 docker exec calls; a guest agent would replace them' }))
  await ctx.fiber?.dispose?.()
} finally {
  await run('docker', ['rm', '-f', ...names]).catch(() => {})
}
for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  [${r.detail}]` : ''}`)
process.exitCode = results.every(r => r.pass) ? 0 : 1
