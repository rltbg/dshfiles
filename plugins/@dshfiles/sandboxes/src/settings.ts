import Schema from '@deepseek-ai/schemastery'
import { Settings } from '@dshfiles/dshx/effect/settings'
import { defineSettings, type SettingsValue } from '@dshfiles/dshx/settings'

export const sandboxesSettings = defineSettings({
  namespace: 'dshfiles-sandboxes',
  schema: Schema.object({
    provider: Schema.union(['auto', 'container', 'directory'])
      .default('auto')
      .description(
        '`auto` runs sandboxes in a Docker or Podman container when one is ready. `directory` is a plain folder on this machine with no isolation, for development and tests only.',
      ),
    containerEngine: Schema.union(['auto', 'docker', 'podman']).default('auto').description('The container engine; `auto` prefers Podman, then Docker.'),
    image: Schema.string()
      .default('dshfiles-sandbox:1')
      .description('The sandbox image: it needs `node` (22 or later), `git` and `bash`. `sandbox_doctor` prints the command that builds the default one.'),
    cpus: Schema.number().min(0.1).default(2).description('CPUs per sandbox.'),
    memoryMb: Schema.natural().min(128).default(2048).description('Memory per sandbox, in MB.'),
    pids: Schema.natural().min(16).default(512).description('Process limit per sandbox.'),
    maxSandboxes: Schema.natural().min(1).default(8).description('Sandboxes that may exist on this machine at once; one more is refused with the count.'),
    stoppedHours: Schema.number()
      .min(0)
      .default(24)
      .description('Hours a stopped sandbox is kept before it is destroyed; `0` destroys it at stop. A sandbox can override it (sandbox_set_retention).'),
    syncAfterTurn: Schema.boolean()
      .default(true)
      .description("After each agent turn in a sandbox, copy its files back as a git snapshot into the sandbox's changes worktree on this machine."),
  }),
})

export type SandboxesSettingsValue = SettingsValue<typeof sandboxesSettings.schema>

/** The live settings of this plugin. */
export const SandboxesSettings = Settings.Tag<SandboxesSettingsValue>(sandboxesSettings.namespace)
