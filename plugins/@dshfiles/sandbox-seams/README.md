# @dshfiles/sandbox-seams

Sends a sandboxed thread's file operations and processes into its sandbox, through the native seams the stock tools
already call: `ctx.fs`, `ctx.subprocess` and `ctx.sandbox`. The `read`, `write`, `edit`, `apply_patch` and `bash` tools
work in a sandbox unchanged. A thread without a sandbox gets exactly the stock providers.

It is the Host half of [per-thread sandboxes](../../../plans/microvm-sandboxes/README.md). It opens no sandbox itself:
the sandbox orchestrator starts one, opens its [guest channel](../sandbox-guest/README.md) and registers a route here.

## How a call is routed

A sandbox serves its workspace at the same absolute path the Host uses, so a path never needs translating. The route
registry (`ctx.sandboxRoutes`, published as the `@dshfiles/sandbox-seams/routes` dshx module) maps each open sandbox's
workspace root to its channel.

| Seam             | Replaces row                | Routed when                                     | Otherwise                          |
| ---------------- | --------------------------- | ----------------------------------------------- | ---------------------------------- |
| `ctx.fs`         | `fs-sandbox`                | the path is inside a sandbox workspace          | stock `SandboxedFileSystem`        |
| `ctx.subprocess` | `dshfiles-subprocess-local` | the working folder is inside a sandbox          | `@dshfiles/subprocess-local`       |
| `ctx.sandbox`    | `sandbox`                   | the policy's workspace root is inside a sandbox | stock `LocalSandboxProvider` chain |

Each routed class extends the class it replaces and calls `super` for unrouted work, so this bundle never forks their
code.

## Guarantees

- **One owner per path.** Two routes never overlap. A thread whose working folder is in a sandbox cannot resolve a path
  outside it (`FS_SANDBOX_DENIED`), nor the Host home with `~`. A thread outside cannot reach into a sandbox.
- **Same text semantics as the local provider.** Realpath identity through the nearest existing ancestor, line endings
  kept on edit, a NUL byte in the first 8 KiB meaning binary, the same error codes.
- **No lost update.** An edit, patch or write computes the new content on the Host and writes it back only over the
  version it read; a change made inside the sandbox meanwhile fails as `FS_STALE_VERSION`.
- **The per-call policy still applies.** `read-only` refuses every mutation; `workspace-write` allows the workspace and
  `/tmp` of the sandbox; `danger-full-access` allows the rest of the sandbox.
- **Processes behave like local ones.** The same stdio dispositions, bounded collection with spill files, stdin data,
  cancellation and TERM-then-KILL escalation of the whole process group. A program the caller resolved on the Host
  (`/usr/bin/git`) runs as the same command name on the sandbox's own `PATH`. `PATH`, `HOME`, `TMPDIR`, `USER`, `SHELL`
  and the other Host-only variables are not forwarded.
- **No double confinement.** `ctx.sandbox.confine` passes a sandboxed command through unchanged: the sandbox is the
  boundary. It reports `full` enforcement under `workspace-write` and `partial` under `read-only`, and classifies no
  stderr line as a denial that a wider Host permission would fix.

## Limits and their way forward

| Not available in a sandbox       | What the caller sees                                                   |
| -------------------------------- | ---------------------------------------------------------------------- |
| Interactive terminals            | `SUBPROCESS_PTY_UNAVAILABLE`: run the command with `bash`              |
| A subprocess control channel     | `SUBPROCESS_SPAWN_FAILED`: run the command without it                  |
| Watching a file                  | `FS_IO_ERROR`: read it again to see changes                            |
| A move across a sandbox boundary | `FS_SANDBOX_DENIED`: write the destination and delete the source       |
| A sandbox that stopped           | `FS_IO_ERROR` or `SUBPROCESS_SPAWN_FAILED`: start it again, then retry |

## Install

The bundle disables three stock rows, so it must come after `@dshfiles/subprocess-local` in a profile's bundle list. It
has no settings and no UI. With no route registered it behaves as the stock providers.

## Verify

```sh
pnpm --dir plugins/@dshfiles/sandbox-seams test
```

The tests run each seam against a real guest agent (a confined local process), including cross-boundary refusals,
stale writes, process groups, abort and a closed channel.
