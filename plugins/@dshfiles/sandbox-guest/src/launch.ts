/**
 * Starting a guest agent. Providers decide where (a container, a microVM, a plain host process); this module
 * knows the agent's own file and how to hand it to `node`.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { GuestChannel } from './channel.js'

export interface StartedGuest {
  readonly channel: GuestChannel
  readonly process: ChildProcess
}

/** Where the guest agent's file is, and how to start it in a sandbox or on this machine. */
export class GuestLauncher {
  /** The built guest agent: one file, Node builtins only. From `src/` (tests), the built copy in `dist/`. */
  static agentPath(): string {
    const beside = fileURLToPath(new URL('./guest-agent.js', import.meta.url))
    return existsSync(beside) ? beside : fileURLToPath(new URL('../dist/guest-agent.js', import.meta.url))
  }

  /** The agent's source, for providers that pass it to `node -e` inside an image that has nothing of dshfiles. */
  static agentSource(): string {
    return readFileSync(GuestLauncher.agentPath(), 'utf8')
  }

  /** The command that runs the agent from its source with any `node` on the sandbox's PATH. */
  static command(input: { readonly root: string; readonly confine?: boolean }): readonly string[] {
    return ['node', '--input-type=module', '-e', GuestLauncher.agentSource(), '--', '--root', input.root, ...(input.confine === true ? ['--confine'] : [])]
  }

  /** Open a channel over a child process's stdio: the child is the sandbox, its stdin and stdout the channel. */
  static attach(child: ChildProcess): StartedGuest {
    if (child.stdin === null || child.stdout === null) throw new Error('the sandbox process needs piped stdin and stdout')
    return { channel: new GuestChannel({ input: child.stdin, output: child.stdout }), process: child }
  }

  /**
   * Run the agent as a plain process on this machine, confined to `root`. This is not isolation: it is the
   * directory provider tests and development use, and the reference behaviour every other provider must match.
   */
  static startLocal(input: { readonly root: string }): StartedGuest {
    return GuestLauncher.attach(
      spawn(process.execPath, [GuestLauncher.agentPath(), '--root', input.root, '--confine'], { cwd: input.root, stdio: ['pipe', 'pipe', 'inherit'] }),
    )
  }
}
