/**
 * `ctx.sandbox` for threads that run in a sandbox. A command for a sandboxed workspace already runs inside the
 * sandbox (the routed `ctx.subprocess` sends it there), so it needs no second confinement runner: the argv passes
 * through and the sandbox's own isolation is the enforcement. Every other workspace gets the stock local runner chain.
 */
import type { ConfinedArgv, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'

export class RoutedSandboxProvider extends LocalSandboxProvider {
  static inject = ['sandboxRoutes']

  override confine(argv: readonly string[], policy: SandboxPolicy, signal?: AbortSignal): Promise<ConfinedArgv> {
    const route = this.ctx.sandboxRoutes.forPath(policy.workspaceRoot)
    if (route === undefined) return super.confine(argv, policy, signal)
    return Promise.resolve({
      argv: [...argv],
      // Under workspace-write the sandbox is the boundary the policy asks for. Under read-only a process can still
      // change the sandbox's own copy of the workspace, which never reaches the Host without an export, so the
      // read-only promise holds only for the Host: partial.
      enforcement: policy.mode === 'workspace-write' ? 'full' : 'partial',
      // A refusal inside the sandbox is not something a wider Host permission would fix, so nothing is classified
      // as a sandbox denial that suggests escalation.
      denialSignatures: [],
      runnerFailureRules: [],
    })
  }
}

export default RoutedSandboxProvider
