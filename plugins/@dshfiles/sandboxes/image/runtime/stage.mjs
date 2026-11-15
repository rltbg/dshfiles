#!/usr/bin/env node
/**
 * Stage the build context of the sandbox runtime image (remote mode A): the DSH core, and the dshfiles bundles a
 * runtime inside a sandbox needs to be reached by the user's DSH through multi-host. Only built output is copied;
 * manifests lose their workspace dependencies, which the image installs from npm at pinned versions instead.
 *
 *   node plugins/@dshfiles/sandboxes/image/runtime/stage.mjs <out-dir>
 *   docker build -t dshfiles-sandbox-runtime:1 <out-dir>
 *
 * Build the staged packages first (pnpm exec turbo run build --filter=@dshfiles/multi-host...).
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../../../../..')
const out = resolve(process.argv[2] ?? join(repo, '.turbo/sandbox-runtime-image'))

/** Packages copied into the image, with the built or source folders their runtime imports reach. */
const packages = [
  { name: '@dshfiles/dshx', from: 'tooling/dshx/packages/dshx', folders: ['dist', 'runtime-store'] },
  { name: '@dshfiles/session-source-port', from: 'plugins/@dshfiles/session-source-port', folders: ['src'] },
  { name: '@dshfiles/multi-host', from: 'plugins/@dshfiles/multi-host', folders: ['dist'], files: ['cordis.patch.yml'] },
]

/** The npm dependencies their runtime code imports, at the versions of pnpm-workspace.yaml's catalog. */
const catalog = readFileSync(join(repo, 'pnpm-workspace.yaml'), 'utf8')
const pinned = name => {
  const match = catalog.match(new RegExp(`^  '?${name.replace('/', '\\/')}'?: (\\S+)$`, 'mu'))
  if (match === null) throw new Error(`${name} has no catalog version in pnpm-workspace.yaml`)
  return match[1]
}
const npmDependencies = Object.fromEntries(['effect', '@effect/platform-node', 'ws', 'zod', 'write-file-atomic'].map(name => [name, pinned(name)]))

rmSync(out, { recursive: true, force: true })
mkdirSync(join(out, 'opt/dshfiles/packages'), { recursive: true })
const local = {}
for (const entry of packages) {
  const source = join(repo, entry.from)
  const target = join(out, 'opt/dshfiles/packages', entry.name.split('/')[1])
  for (const folder of entry.folders) {
    if (!existsSync(join(source, folder))) throw new Error(`${entry.name}: ${folder} is missing; build it first`)
    cpSync(join(source, folder), join(target, folder), { recursive: true, filter: path => !path.includes('/node_modules') })
  }
  for (const file of entry.files ?? []) cpSync(join(source, file), join(target, file))
  // ast-grep-ignore: no-direct-json-parse -- a build script reading the repository's own manifest
  const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
  for (const key of ['dependencies', 'devDependencies', 'peerDependencies', 'scripts', 'files']) delete manifest[key]
  writeFileSync(join(target, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  local[entry.name] = `file:packages/${entry.name.split('/')[1]}`
}
writeFileSync(
  join(out, 'opt/dshfiles/package.json'),
  `${JSON.stringify({ name: 'dshfiles-sandbox-runtime', private: true, dependencies: { ...npmDependencies, ...local } }, null, 2)}\n`,
)
cpSync(join(here, 'Dockerfile'), join(out, 'Dockerfile'))
cpSync(join(here, 'start-runtime.sh'), join(out, 'start-runtime.sh'))
console.log(`staged ${out}`)
