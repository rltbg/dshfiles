# @dshfiles/sandbox-guest

The guest agent that runs in every sandbox, and the host end of its channel.

A sandbox (a container or a microVM) starts this agent as its first process. The user's DSH then reaches the
sandbox through **one channel: the sandbox's own stdin and stdout**. File operations, process starts, process
input and output all travel on it as one JSON object per line. There is no published port, no mounted socket,
and no `docker exec` per call, so a container can run with `--network none`.

Measured with Docker on one machine ([spike S14](../../../plans/microvm-sandboxes/P0-findings.md)): a file
operation takes 0.54 ms at p50, against 86 ms for one `docker exec`.

## What it offers

| Import                                                              | Use                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GuestChannel` from `@dshfiles/sandbox-guest/channel`               | `request(op, args)` for `stat`, `list`, `read`, `write`, `delete`, `rename`, `realpath`, `which`, each result decoded with its schema; `spawn()` for a process whose `stdin`, `stdout`, `stderr` and `done` behave like a local child's; `close()` ends the sandbox |
| `GuestLauncher.attach(child)` from `@dshfiles/sandbox-guest/launch` | open a channel over a child process's stdio (`docker run -i …`, `podman run -i …`)                                                                                                                                                                                  |
| `GuestLauncher.command({ root })`                                   | the `node --input-type=module -e <agent>` command a provider runs in an image that has Node                                                                                                                                                                         |
| `GuestLauncher.startLocal({ root })`                                | run the agent on this machine, confined to `root` — no isolation; for tests and the directory provider                                                                                                                                                              |
| `@dshfiles/sandbox-guest/protocol`                                  | the message and result schemas, and the protocol version                                                                                                                                                                                                            |

The agent writes atomically (a temporary file, then a rename) and guards writes with the same
`dev:ino:size:mtimeNs:ctimeNs` version token the local filesystem uses, so the routed filesystem keeps DSH's
stale-write checks. `--confine` refuses any path outside the root, through symlinks too.

## Limits

- The agent needs `node` in the image. A single static binary that works in any image is planned
  ([plan, section 3.3](../../../plans/microvm-sandboxes/README.md)).
- Payloads are base64 inside JSON: fine for source files, not tuned for very large binaries.
- No terminals (PTY) and no file watching yet.

## Checks

```sh
pnpm --dir plugins/@dshfiles/sandbox-guest test
```

The container test runs when Docker answers and the `node:22-alpine` image is present
(`SANDBOX_GUEST_TEST_IMAGE` picks another).
