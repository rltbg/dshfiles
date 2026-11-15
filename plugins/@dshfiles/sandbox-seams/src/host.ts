import type { Context } from '@deepseek-ai/cordis'
import { RoutedFileSystem } from './routed-fs.ts'
import { RoutedSandboxProvider } from './routed-sandbox.ts'
import { RoutedSubprocessRuntime } from './routed-subprocess.ts'
import { SandboxRoutes } from './routes.ts'

/**
 * The route registry and the three routed providers. Each provider takes the place of the stock row this bundle
 * disables, with that row's (empty) configuration.
 */
export const apply = (ctx: Context): void => {
  ctx.plugin(SandboxRoutes)
  ctx.plugin(RoutedSubprocessRuntime)
  ctx.plugin(RoutedSandboxProvider, {})
  ctx.plugin(RoutedFileSystem, {})
}
