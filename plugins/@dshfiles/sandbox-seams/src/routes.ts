/**
 * Which sandbox serves which folder. The orchestrator that opens a sandbox registers its workspace root and channel
 * here; the routed `ctx.fs`, `ctx.subprocess` and `ctx.sandbox` providers look a path up and send the call into that
 * sandbox. A sandbox serves its workspace at the same absolute path the Host would use, so a path never needs
 * translating: the route only says where to send it.
 */
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import type { GuestChannel } from '@dshfiles/sandbox-guest/channel'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Sandbox workspaces and the channel that reaches each one. */
    sandboxRoutes: SandboxRoutes
  }
}

export interface SandboxRoute {
  /** The sandbox record's id. */
  readonly id: string
  /** Absolute workspace folder. The sandbox serves it at this same path. */
  readonly root: string
  /** The open channel to the sandbox's guest agent. */
  readonly channel: GuestChannel
}

/** `child` is `parent` or inside it, by spelling. Neither needs to exist on the Host. */
export class RoutePaths {
  static contains(parent: string, child: string): boolean {
    const path = relative(parent, child)
    return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
  }

  /** The absolute, normalized spelling of `path` against `cwd`. */
  static absolute(path: string, cwd: string): string {
    return resolve(cwd, path)
  }
}

export class SandboxRoutes extends Service {
  private readonly routes = new Map<string, SandboxRoute>()

  constructor(ctx: Context) {
    super(ctx, 'sandboxRoutes')
  }

  /**
   * Route `root` into a sandbox until the returned function runs. A root inside or around another route's root is
   * refused: one path must never have two owners.
   */
  register(route: SandboxRoute): () => void {
    const root = resolve(route.root)
    if (this.routes.has(route.id)) throw new Error(`sandbox ${route.id} already has a route`)
    for (const other of this.routes.values()) {
      if (RoutePaths.contains(other.root, root) || RoutePaths.contains(root, other.root))
        throw new Error(`sandbox ${route.id} cannot route ${root}: sandbox ${other.id} already routes ${other.root}`)
    }
    const registered: SandboxRoute = { id: route.id, root, channel: route.channel }
    this.routes.set(route.id, registered)
    return () => {
      if (this.routes.get(route.id) === registered) this.routes.delete(route.id)
    }
  }

  get(id: string): SandboxRoute | undefined {
    return this.routes.get(id)
  }

  list(): readonly SandboxRoute[] {
    return [...this.routes.values()]
  }

  /** The route whose workspace holds the absolute `path`, if any. */
  forPath(path: string): SandboxRoute | undefined {
    const absolute = resolve(path)
    for (const route of this.routes.values()) if (RoutePaths.contains(route.root, absolute)) return route
    return undefined
  }
}

export default SandboxRoutes
