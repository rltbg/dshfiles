// Spike S14: one long-lived channel per container, over the container's own stdin/stdout, instead of a
// `docker exec` per call. The container keeps `--network none`. Measures the round trip and checks isolation.
// Usage: node s14-channel.mjs [docker|podman]
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'

const engine = process.argv[2] ?? 'docker'
const run = promisify(execFile)

// The guest agent: newline-delimited JSON requests in, responses out. Kept small and dependency-free so it can
// be passed with `node -e`; the real one is a separate binary (plan, section 3.3).
const GUEST = String.raw`
const fs = require('node:fs'), cp = require('node:child_process'), path = require('node:path')
const root = '/workspace'
const inside = p => { const full = path.resolve(root, p); if (full !== root && !full.startsWith(root + '/')) throw new Error('outside workspace'); return full }
const send = m => process.stdout.write(JSON.stringify(m) + '\n')
const ops = {
  ping: () => ({}),
  write: a => { const f = inside(a.path); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, a.text); return {} },
  read: a => ({ text: fs.readFileSync(inside(a.path), 'utf8') }),
  stat: a => { try { const s = fs.statSync(inside(a.path)); return { size: s.size, dir: s.isDirectory() } } catch { return { missing: true } } },
  exec: a => new Promise(resolve => {
    const child = cp.spawn(a.argv[0], a.argv.slice(1), { cwd: inside(a.cwd ?? '.') })
    let out = '', err = ''
    child.stdout.on('data', c => (out += c)); child.stderr.on('data', c => (err += c))
    child.on('error', e => resolve({ code: -1, out, err: String(e) }))
    child.on('close', code => resolve({ code, out, err }))
  }),
}
let buf = ''
process.stdin.on('data', chunk => {
  buf += chunk
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    const req = JSON.parse(line)
    Promise.resolve().then(() => ops[req.op](req)).then(r => send({ id: req.id, ok: true, ...r }), e => send({ id: req.id, ok: false, error: String(e.message ?? e) }))
  }
})
process.stdin.on('end', () => process.exit(0))
send({ ready: true, uid: process.getuid() })
`

const hardened = ['--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--read-only', '--network', 'none', '--pids-limit', '128',
  '--memory', '256m', '--user', '1000:1000', '--tmpfs', '/workspace:uid=1000,gid=1000,size=64m', '--tmpfs', '/tmp:size=16m']

/** Start a container whose main process is the guest agent, and keep its stdio as the channel. */
const openChannel = name =>
  new Promise((resolve, reject) => {
    const startedAt = performance.now()
    const child = spawn(engine, ['run', '-i', '--rm', '--name', name, ...hardened, 'node:22-alpine', 'node', '-e', GUEST], { stdio: ['pipe', 'pipe', 'pipe'] })
    const pending = new Map()
    let next = 0
    let buf = ''
    let ready = false
    child.stderr.on('data', c => process.stderr.write(`[${name}] ${c}`))
    child.on('error', reject)
    child.on('close', code => {
      if (!ready) reject(new Error(`${name} exited ${code} before ready`))
      for (const { fail } of pending.values()) fail(new Error(`${name} closed`))
    })
    child.stdout.on('data', chunk => {
      buf += chunk
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const message = JSON.parse(buf.slice(0, i))
        buf = buf.slice(i + 1)
        if (message.ready) {
          ready = true
          resolve({
            name,
            uid: message.uid,
            readyMs: Math.round(performance.now() - startedAt),
            call: (op, args = {}) =>
              new Promise((ok, fail) => {
                const id = ++next
                pending.set(id, { ok, fail })
                child.stdin.write(`${JSON.stringify({ id, op, ...args })}\n`)
              }),
            close: () => new Promise(done => { child.once('close', done); child.stdin.end() }),
          })
          continue
        }
        const waiter = pending.get(message.id)
        pending.delete(message.id)
        if (message.ok) waiter.ok(message)
        else waiter.fail(new Error(message.error))
      }
    })
  })

const results = []
const check = (name, pass, detail = '') => results.push({ name, pass, detail })
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(p * values.length))]

await run(engine, ['rm', '-f', 's14-a', 's14-b']).catch(() => {})
const [a, b] = await Promise.all([openChannel('s14-a'), openChannel('s14-b')])
try {
  check('both guest agents report ready over stdio', true, `ready in ${a.readyMs} / ${b.readyMs} ms, uid ${a.uid}`)
  check('the guest agent runs as a non-root user', a.uid === 1000 && b.uid === 1000, `uid ${a.uid}`)

  await a.call('write', { path: 'notes/secret.txt', text: 'only-in-A' })
  check('A writes and reads back through the channel', (await a.call('read', { path: 'notes/secret.txt' })).text === 'only-in-A')
  check('B does not see A\'s file', (await b.call('stat', { path: 'notes/secret.txt' })).missing === true)
  const escape = await a.call('read', { path: '../etc/passwd' }).then(() => 'read', e => e.message)
  check('a path outside the workspace is refused by the guest agent', escape === 'outside workspace', escape)

  const net = await a.call('exec', { argv: ['node', '-e', "require('node:net').connect(443,'1.1.1.1').on('error',e=>{console.log(e.code);process.exit(0)}).on('connect',()=>{console.log('CONNECTED');process.exit(0)})"] })
  check('the container has no network', !net.out.includes('CONNECTED'), net.out.trim() || net.err.trim())
  const ls = await a.call('exec', { argv: ['sh', '-c', 'cat notes/secret.txt; echo; id -u; ip -o link 2>/dev/null | wc -l'] })
  check('a command runs in the workspace and sees the file', ls.code === 0 && ls.out.startsWith('only-in-A\n1000\n'), ls.out.replace(/\n/g, ' | '))

  // Round trips: sequential, then two containers in parallel.
  const seq = []
  for (let i = 0; i < 500; i += 1) {
    const at = performance.now()
    await a.call('ping')
    seq.push(performance.now() - at)
  }
  const fileOps = []
  for (let i = 0; i < 200; i += 1) {
    const at = performance.now()
    await a.call('write', { path: `f${i}.txt`, text: `A-${i}` })
    await a.call('read', { path: `f${i}.txt` })
    fileOps.push((performance.now() - at) / 2)
  }
  const parallelAt = performance.now()
  const both = await Promise.all([a, b].map(async (side, n) => {
    for (let i = 0; i < 500; i += 1) {
      await side.call('write', { path: `p${i}.txt`, text: `${n}-${i}` })
      if ((await side.call('read', { path: `p${i}.txt` })).text !== `${n}-${i}`) return false
    }
    return true
  }))
  const parallelMs = performance.now() - parallelAt
  check('2 x 1,000 interleaved file operations, no cross-talk', both.every(Boolean))
  const execs = []
  for (let i = 0; i < 20; i += 1) {
    const at = performance.now()
    await a.call('exec', { argv: ['true'] })
    execs.push(performance.now() - at)
  }
  const timings = {
    pingP50Ms: +percentile(seq, 0.5).toFixed(3),
    pingP99Ms: +percentile(seq, 0.99).toFixed(3),
    fileOpP50Ms: +percentile(fileOps, 0.5).toFixed(3),
    fileOpP99Ms: +percentile(fileOps, 0.99).toFixed(3),
    parallelFileOpsPerSecond: Math.round(2000 / (parallelMs / 1000)),
    processSpawnP50Ms: +percentile(execs, 0.5).toFixed(1),
  }
  check('file operation round trip under the 5 ms budget (p99)', timings.fileOpP99Ms < 5, `${timings.fileOpP99Ms} ms`)
  console.log(JSON.stringify(timings))
} finally {
  await Promise.all([a.close(), b.close()])
}
const left = (await run(engine, ['ps', '-aq', '--filter', 'name=s14-'])).stdout.trim()
check('closing the channel stops and removes the container', left === '', left)
for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  [${r.detail}]` : ''}`)
process.exitCode = results.every(r => r.pass) ? 0 : 1
