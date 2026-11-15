import { defineApi, method } from '@dshfiles/dshx/api'
import { Schema } from 'effect'
import { sandboxRecordSchema } from './records.ts'

const id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64))
const sandboxView = Schema.Struct({ ...sandboxRecordSchema.fields, running: Schema.Boolean })
const readiness = Schema.Struct({
  provider: Schema.Literals(['container', 'directory']),
  mode: Schema.Literals(['workspace', 'runtime']),
  ready: Schema.Boolean,
  isolation: Schema.Literals(['container', 'none']),
  detail: Schema.String,
  fix: Schema.optional(Schema.String),
})

const line = (sandbox: typeof sandboxView.Type): string =>
  `${sandbox.id} · ${sandbox.title} · ${sandbox.provider} · ${sandbox.state}${sandbox.running ? ' (running)' : ''} · ${sandbox.workspace}`

export const sandboxesApi = defineApi({
  id: 'sandboxes',
  version: 1,
  owner: '@dshfiles/sandboxes',
  methods: {
    list: method({
      input: Schema.Struct({}),
      output: Schema.Struct({ sandboxes: Schema.Array(sandboxView) }),
      description: 'List the sandboxes on this machine: id, title, provider, state, workspace folder and where their changes land. Read-only.',
      tool: { name: 'sandbox_list', readOnly: true, render: output => output.sandboxes.map(line).join('\n') || 'No sandboxes.' },
    }),
    inspect: method({
      input: Schema.Struct({ id }),
      output: sandboxView,
      description:
        'One sandbox in full: state, project and base commit, workspace, changes worktree, last sync, retention and the last failure with its recovery. Read-only.',
      tool: { name: 'sandbox_inspect', readOnly: true, render: output => JSON.stringify(output, null, 2) },
    }),
    logs: method({
      input: Schema.Struct({ id }),
      output: Schema.Struct({ running: Schema.Boolean, text: Schema.String }),
      description: "A running sandbox's guest agent diagnostics and its container engine's messages, bounded. Read-only.",
      tool: { name: 'sandbox_logs', readOnly: true, render: output => (output.running ? output.text || '(no output)' : 'The sandbox is not running.') },
    }),
    doctor: method({
      input: Schema.Struct({}),
      output: Schema.Struct({ providers: Schema.Array(readiness) }),
      description: 'For each sandbox provider: whether this machine can run it, what was found, and the exact step that makes it ready. Read-only.',
      tool: {
        name: 'sandbox_doctor',
        readOnly: true,
        render: output =>
          output.providers
            .map(
              provider =>
                `${provider.provider} (${provider.mode}): ${provider.ready ? 'ready' : 'not ready'} · ${provider.detail}${provider.fix === undefined ? '' : ` · fix: ${provider.fix}`}`,
            )
            .join('\n'),
      },
    }),
    create: method({
      input: Schema.Struct({
        path: Schema.String.check(Schema.isMinLength(1)),
        base: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))),
        title: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120))),
        mode: Schema.optional(Schema.Literals(['workspace', 'runtime'])),
      }),
      output: sandboxView,
      description:
        "Create a sandbox from the git repository holding `path`: its `base` commit (HEAD when omitted) is copied in, the sandbox's folder is registered as a DSH project so a thread can start in it, and its changes come back as git snapshots into its changes worktree. Call only when the user asked for a sandbox.",
      tool: { name: 'sandbox_create', render: output => `Created ${line(output)}. Start a thread in the project "${output.title}" to work in it.` },
    }),
    start: method({
      input: Schema.Struct({ id }),
      output: sandboxView,
      description: 'Start a stopped sandbox again with its files as they were. Call only when the user asked.',
      tool: { name: 'sandbox_start', render: output => `Started ${line(output)}.` },
    }),
    stop: method({
      input: Schema.Struct({ id }),
      output: sandboxView,
      description: "Copy a running sandbox's changes back, then stop it; its files stay until retention destroys it. Call only when the user asked.",
      tool: { name: 'sandbox_stop', render: output => `Stopped ${line(output)}.` },
    }),
    export: method({
      input: Schema.Struct({ id }),
      output: Schema.Struct({ commit: Schema.String, worktree: Schema.Literals(['updated', 'created', 'held']) }),
      description:
        "Copy a running sandbox's whole working tree back now, as a git snapshot fetched into this machine's repository and checked out in its changes worktree. Call only when the user asked.",
      tool: {
        name: 'sandbox_export',
        render: output =>
          output.worktree === 'held'
            ? `Fetched snapshot ${output.commit}; the changes worktree has edits of its own, so it was left as it is.`
            : `Snapshot ${output.commit} is checked out in the changes worktree.`,
      },
    }),
    setRetention: method({
      input: Schema.Struct({ id, stoppedHours: Schema.NullOr(Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))) }),
      output: sandboxView,
      description: "Set how many hours this sandbox is kept once stopped (null: the setting's default; 0: destroy at stop). Call only when the user asked.",
      tool: {
        name: 'sandbox_set_retention',
        render: output => `${output.id} is kept ${output.stoppedHours === null ? 'for the default time' : `${output.stoppedHours} h`} once stopped.`,
      },
    }),
    destroy: method({
      input: Schema.Struct({ id, confirmDestroy: Schema.Boolean }),
      output: Schema.Struct({ id: Schema.String, changesKept: Schema.Boolean, changes: Schema.String, snapshotRef: Schema.String }),
      description:
        "Destroy a sandbox: its files, processes and record. Its last snapshot stays in this machine's repository, and its changes worktree stays when it holds edits of its own. Requires confirmDestroy: true, which only the user may approve.",
      tool: {
        name: 'sandbox_destroy',
        render: output =>
          `Destroyed ${output.id}. Its last snapshot is ${output.snapshotRef}${output.changesKept ? `; ${output.changes} was kept because it holds edits` : ''}.`,
      },
    }),
  },
})
