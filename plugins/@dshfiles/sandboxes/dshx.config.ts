import { defineConfig } from '@dshfiles/dshx'

export default defineConfig({
  name: '@dshfiles/sandboxes',
  // The guest channel and the git runner are plain libraries; the guest agent's own file is read at run time from the
  // installed @dshfiles/sandbox-guest, since it runs inside the sandbox, not in this bundle.
  host: { dshxRuntime: 'snapshot', entry: 'src/host.ts', bundleDependencies: ['@dshfiles/sandbox-guest', '@dshfiles/git-cli'] },
  modules: { api: 'src/api.ts' },
  build: { sourcemap: true, declarations: true, minify: false },
})
