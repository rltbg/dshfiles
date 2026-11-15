import { defineConfig } from '@dshfiles/dshx'

export default defineConfig({
  name: '@dshfiles/sandbox-seams',
  // The guest channel is a plain library, not a Cordis bundle, so the Host entry carries its own copy.
  host: { dshxRuntime: 'snapshot', entry: 'src/host.ts', bundleDependencies: ['@dshfiles/sandbox-guest'] },
  // The route registry, for the sandbox orchestrator that opens a sandbox and registers its channel here.
  modules: { routes: 'src/routes.ts' },
  build: { sourcemap: true, minify: false },
})
