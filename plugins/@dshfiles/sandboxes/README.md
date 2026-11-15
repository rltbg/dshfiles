# @dshfiles/sandboxes

Per-thread sandboxes. A sandbox is a copy of a project that a thread works in, isolated from your machine: its files
live in a container's volume, its commands run in that container with no network, and its changes come back to your
machine as git snapshots after every turn. Your own checkout is never touched.

The agent loop stays in your DSH. Only the "hands" go into the sandbox: every file operation and every command of a
thread whose folder is a sandbox's workspace is routed there by [`@dshfiles/sandbox-seams`](../sandbox-seams/README.md),
through the sandbox's [guest channel](../sandbox-guest/README.md). The stock `read`, `write`, `edit`, `apply_patch` and
`bash` tools work unchanged.

## Use it

1. Build the default image once (or set `image` to your own with `node` 22+, `git` and `bash`):

   ```sh
   docker build -t dshfiles-sandbox:1 plugins/@dshfiles/sandboxes/image
   ```

   `sandbox_doctor` says what is missing on a machine and prints the exact command.

2. Ask the agent to create a sandbox for a project (`sandbox_create`), or call the `sandboxes` API's `create`. The
   sandbox's folder is registered as a DSH project named "Sandbox · <project>".
3. Start a thread in that project. Everything it reads, writes and runs happens in the sandbox.
4. After each turn the sandbox's whole working tree (untracked files included) is fetched into your repository as
   `refs/dshfiles/sandbox/<id>` and checked out in `~/.dsh/sandboxes/<id>/changes`, a separate git worktree. Review it
   there and land it as you would any branch: `git switch -c my-change refs/dshfiles/sandbox/<id>`.

## Two modes

| Mode                  | Where the agent runs                           | Reached by                                                               |
| --------------------- | ---------------------------------------------- | ------------------------------------------------------------------------ |
| `workspace` (default) | in your DSH; files and commands in the sandbox | the routed seams of `@dshfiles/sandbox-seams`                            |
| `runtime`             | in a whole DSH inside the sandbox              | multi-host, through a loopback port forwarded over the sandbox's channel |

A `runtime` sandbox (remote mode A) is for a sandbox host: the agent, its tools and its conversation all stay inside
the container; the host only relays bytes. Build its image once:

```sh
pnpm exec turbo run build --filter=@dshfiles/multi-host --filter=@dshfiles/dshx
node plugins/@dshfiles/sandboxes/image/runtime/stage.mjs .turbo/sandbox-runtime-image
docker build -t dshfiles-sandbox-runtime:1 .turbo/sandbox-runtime-image
```

`sandbox_create` with `mode: "runtime"` copies the project in, starts the DSH inside, and publishes its launch file at
`~/.dsh/sandboxes/<id>/home/plugins/multi-host/launch.json` on the host. Register that home as a runtime of the host in
multi-host (Find, on the host's row), then start threads on it: they run inside the sandbox. The runtime's DSH home
lives on the sandbox's volume, so the conversation survives a stop and start.

Not done yet: the runtime has no network, so it reaches no model until the egress proxy lands (it will carry the
model key on the host, never inside the sandbox).

## Lifecycle

```
preparing → starting → ready → stopping → stopped → (destroyed)
     └──────────┴─────────┴─────────┴──────────► failed(step, recovery)
```

| Tool                    | Does                                                                                      |
| ----------------------- | ----------------------------------------------------------------------------------------- |
| `sandbox_list`          | every sandbox, its state and folders (read-only)                                          |
| `sandbox_inspect`       | one sandbox in full, its last sync and its last failure with the recovery (read-only)     |
| `sandbox_logs`          | the guest agent's and the engine's messages (read-only)                                   |
| `sandbox_doctor`        | for each provider, whether this machine can run it and the step that fixes it (read-only) |
| `sandbox_create`        | create from a git repository, at HEAD or a given commit                                   |
| `sandbox_start`         | start a stopped sandbox with its files as they were                                       |
| `sandbox_stop`          | copy the changes back, then stop                                                          |
| `sandbox_export`        | copy the changes back now                                                                 |
| `sandbox_set_retention` | hours this sandbox is kept once stopped                                                   |
| `sandbox_destroy`       | delete it; needs `confirmDestroy: true`                                                   |

Write tools run only when the user asked. Destroying keeps the last snapshot ref, and keeps the changes worktree if you
edited it.

After a DSH restart, every sandbox that was running is marked stopped (its container ended with the channel) and can be
started again; volumes or folders with no record are removed. Stopped sandboxes are destroyed after `stoppedHours`.

## Isolation

The container provider runs each sandbox with:

- `--cap-drop ALL`, `--security-opt no-new-privileges`, `--read-only` root, `--network none`;
- uid 1000, `--pids-limit`, `--memory`, `--cpus` from the settings;
- the workspace in a named volume (`dshfiles-sandbox-<id>`) mounted at the same absolute path as the folder on your
  machine, which stays an empty anchor, and a size-limited `/tmp`;
- no published port, no mounted socket and no host folder: the guest agent is the container's first process and its
  stdin and stdout are the only channel.

Rootless Podman is recommended; a rootful Docker works. Only git objects come back to your machine: the fetch runs with
hooks off and checks every object, and nothing from the sandbox runs on your machine.

The `directory` provider is a plain folder on your machine with no isolation, for developing and testing this plugin;
`auto` never picks it.

## Settings (`dshfiles-sandboxes`)

| Key               | Default              | Effect                                                                 |
| ----------------- | -------------------- | ---------------------------------------------------------------------- |
| `provider`        | `auto`               | `auto` or `container`; `directory` for development only                |
| `containerEngine` | `auto`               | `auto` prefers Podman, then Docker                                     |
| `image`           | `dshfiles-sandbox:1` | the sandbox image                                                      |
| `cpus`            | `2`                  | CPUs per sandbox                                                       |
| `memoryMb`        | `2048`               | memory per sandbox                                                     |
| `pids`            | `512`                | process limit per sandbox                                              |
| `maxSandboxes`    | `8`                  | sandboxes that may exist at once                                       |
| `stoppedHours`    | `24`                 | hours a stopped sandbox is kept; `0` destroys at stop                  |
| `syncAfterTurn`   | `true`               | copy changes back after every agent turn; off: only on export and stop |

Settings apply to the next create or start. No restart is needed.

## Install

Add `@dshfiles/sandbox-seams` and then `@dshfiles/sandboxes` to the profile's bundles, after
`@dshfiles/subprocess-local`. With no sandbox open, both behave as the stock providers.

## Limits

- Interactive terminals do not run in a sandbox yet; `bash` does.
- Network inside the sandbox is off: package installs need the image to carry the dependencies for now.
- A sandbox is created explicitly; making every new thread a sandbox by default is the next step.

## Verify

```sh
pnpm --dir plugins/@dshfiles/sandboxes test
SANDBOXES_TEST_IMAGE=dshfiles-sandbox:1 pnpm --dir plugins/@dshfiles/sandboxes test
```

The first run covers the lifecycle, git sync, retention, restart and refusals on the directory provider. With an engine
and an image, the second also runs a real hardened container end to end.
