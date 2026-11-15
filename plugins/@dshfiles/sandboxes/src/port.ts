/**
 * The contract a sandbox provider implements: where a sandbox runs (a container, a plain folder, later a microVM) and
 * how its guest channel is opened. The orchestrator owns records, routing and git sync; a provider owns only its
 * machine resources.
 */
import type { GuestChannel } from '@dshfiles/sandbox-guest/channel'
import type { Effect } from 'effect'
import type { SandboxStepFailed } from './errors.ts'

export type ProviderId = 'container' | 'directory'

/** `workspace`: the agent runs in the user's DSH; `runtime`: a whole DSH runs inside the sandbox. */
export type SandboxMode = 'workspace' | 'runtime'

export interface SandboxSpec {
  readonly id: string
  /** Absolute workspace folder; the sandbox serves it at this same path. */
  readonly workspace: string
  /**
   * The sandbox's own folder, the workspace's parent. Everything the sandbox keeps between starts lives under it: the
   * workspace and, in runtime mode, the DSH home of the runtime inside, at the same absolute paths as on this machine.
   */
  readonly folder: string
  readonly image: string
  readonly cpus: number
  readonly memoryMb: number
  readonly pids: number
}

export interface ProviderReadiness {
  readonly provider: ProviderId
  readonly mode: SandboxMode
  readonly ready: boolean
  /** `container` isolates the sandbox; `none` is a plain folder on this machine. */
  readonly isolation: 'container' | 'none'
  /** What was found, in one sentence. */
  readonly detail: string
  /** The exact step that makes the provider ready, when it is not. */
  readonly fix?: string
}

/** A running sandbox. */
export interface StartedSandbox {
  readonly channel: GuestChannel
  /** The guest agent's own diagnostics (its stderr), bounded. */
  readonly logs: Effect.Effect<string>
  /** End the channel and the sandbox's processes; the workspace stays for a later start. */
  readonly stop: Effect.Effect<void>
}

export interface SandboxProvider {
  readonly id: ProviderId
  /** Whether this machine can run a sandbox of that mode now, and the step that fixes it when not. */
  readonly describe: (mode: SandboxMode) => Effect.Effect<ProviderReadiness>
  /** Allocate what a sandbox keeps between starts (a volume, a folder). */
  readonly create: (spec: SandboxSpec) => Effect.Effect<void, SandboxStepFailed>
  readonly start: (spec: SandboxSpec) => Effect.Effect<StartedSandbox, SandboxStepFailed>
  /** Release everything `create` allocated. Destroying what is already gone succeeds. */
  readonly destroy: (spec: SandboxSpec) => Effect.Effect<void, SandboxStepFailed>
  /** The ids of every sandbox this provider holds resources for, records or not. */
  readonly list: Effect.Effect<readonly string[], SandboxStepFailed>
}
