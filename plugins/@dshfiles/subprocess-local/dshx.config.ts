import { defineConfig } from '@dshfiles/dshx'

export default defineConfig({
  name: '@dshfiles/subprocess-local',
  host: { dshxRuntime: 'snapshot', entry: 'src/host.ts' },
  // The runtime class and its output collector, for @dshfiles/sandbox-seams, which extends the runtime to route a
  // sandboxed thread's processes into its sandbox and keeps this fork for every other thread.
  modules: { runtime: 'src/native/index.ts', output: 'src/native/output.ts' },
  build: { sourcemap: true, minify: false },
})
