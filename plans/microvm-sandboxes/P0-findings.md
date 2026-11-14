# P0 findings

Evidence gathered so far. Each entry says where it was run and what it proves. Nothing here is a decision
until the README records it.

## Environment (cloud session, 2026-11-14)

| Fact | Evidence |
| --- | --- |
| No microVM can start here | `/dev/kvm` is absent; the CPU reports no `vmx`/`svm` flag |
| The session runs as root | `id -u` → `0` |
| Docker runs here | `dockerd` 29.9.2 started by hand with a short `--exec-root` (the default scratch path exceeded the Unix-socket length limit); `overlayfs`, cgroup v1, runtime `runc` |
| A hardened container starts | `docker run --rm --cap-drop ALL --security-opt no-new-privileges --read-only --tmpfs /tmp:size=16m --pids-limit 64 --memory 128m --network none --user 1000:1000 node:22-alpine node -e …` → printed the Node version and uid `1000` |

## S3. Where the agent's file and process work runs in DSH core

Read from the installed core packages (`@deepseek-ai/dsh` 0.2.1-rc.2 in a scratch install; the repository now
pins 0.2.2-rc.2, to be re-read there).

**Finding: core already has the seams a sandbox needs, and says to use them.**

- `@deepseek-ai/dsh-fs` is "the abstract filesystem capability seam (`ctx.fs`)", described as giving
  "consistent filesystem operations across host, confined, or remote execution environments". Its notes address
  a remote backend directly (for example, "a remote backend may implement [`editText`] as a native
  compare-and-edit").
- `@deepseek-ai/dsh-subprocess` (`ctx.subprocess`): "Configure one subprocess implementation for each
  composition, choosing local or remote execution according to where commands must run."
- `@deepseek-ai/dsh-sandbox` (`ctx.sandbox`) is **same-world** confinement only: bubblewrap, Landlock, macOS
  Seatbelt or a Windows restricted token, with the modes `read-only`, `workspace-write` and
  `danger-full-access`. Its README states the boundary: "containers, microVMs, and remote execution require
  replacing capability implementations rather than adding a provider here", and "Remote compositions replace
  all three providers".
- The core file tools go through the seam: `@deepseek-ai/dsh-tool-fs` imports `@deepseek-ai/dsh-fs` and
  `@deepseek-ai/dsh-sandbox`, not `node:fs`. The MCP client starts servers through `@deepseek-ai/dsh-subprocess`.
- The shipped base bundle mounts `dsh-sandbox-local`, `dsh-sandbox-policy`, `dsh-fs-sandbox` and
  `dsh-fs-observation-policy`. So today a thread's **writes** are already fenced to its workspace by the OS;
  **reads** pass through, the kernel is shared, and the network is not covered.
- The per-call policy takes the Session: `resolve({ session, mode })`, with "the session's immutable `cwd`"
  as the workspace root.

In our own plugins (grep over `plugins/@dshfiles/*/src`, Host code, tests and vendored `native/` excluded):

- The file-editing agent tools use the seam: `tool-fs` (our fork) and `apply-patch` call `ctx.fs`.
- Plugins that import `node:fs` and also register tools mostly touch their own state (accounts, indexes), not
  project files.
- Known bypasses of the seams for project content: `fff-search` (grep/glob from a host-side index),
  `jj-integration` and `project-checks` (they spawn processes directly), `pull-requests`.

**What this changes.** The plan's section 3.1 dismissed "exec-only" because it "needs forks of every tool". That
is wrong: replacing `ctx.fs`, `ctx.subprocess` and `ctx.sandbox` is the route core documents, and the main file
and shell tools already go through them. The two architectures must be compared on evidence:

| | A. Guest runtime (the plan as written) | B. Replace the three capability seams |
| --- | --- | --- |
| What runs in the sandbox | a whole DSH runtime: agent loop, tools, MCP | only the commands and the files; a small guest agent |
| Start time | VM start plus a runtime boot (about 8 s of CPU measured for the full web composition); needs a warm pool or snapshot for 2 s | VM start plus loading the project |
| Memory per sandbox | a runtime, target 300 MB | the guest agent and whatever the commands use |
| Model key | must be kept out through a proxy | never leaves the Host: the agent loop stays there |
| Guest image | carries Node, DSH and our bundles; rebuilt when dshfiles changes | any image with the project's toolchain; independent of dshfiles |
| Thread in the UI | a mirrored remote thread, with multi-host's current limits (polled transcript, no preset chip, no LSP) | an ordinary local thread |
| What escapes the sandbox | nothing of the agent | whatever does not go through the seams: `fff-search`, plugins that spawn directly |
| Open question | runtime boot time in a minimal profile | per-Session routing, since a composition mounts one provider per seam |
| Reuses | multi-host's remote-thread path | core's documented extension seams |

Not yet verified for B: whether one provider can route each call to the right sandbox (by the Session, its
`cwd` or the path), and how terminal sessions and background jobs behave through a remote subprocess provider.

## S12. Architecture B: one provider per seam, routed per thread (run here, 2026-11-14)

Script: [`spikes/s12-routing.mjs`](spikes/s12-routing.mjs). Run: `node plans/microvm-sandboxes/spikes/s12-routing.mjs <checkout>`
with Docker running. It starts two hardened containers, mounts one `FileSystem` and one `SubprocessRuntime`
subclass (core's own abstract classes, from the workspace's installed packages) in a Cordis context, and gives
each thread a working directory that exists only as a name on the Host (`/sandboxes/thread-a/workspace`).

Result: **12 of 12 checks pass.**

| Check | Observation |
| --- | --- |
| The providers mount under the names core consumers use | `ctx.fs` and `ctx.subprocess` are instances of core's classes |
| A file written through `ctx.fs` is seen by a command spawned through `ctx.subprocess` | `cat` printed the content |
| Thread B, same relative path | a different target; A's file does not exist; B's workspace is empty; uid 1000; its own container |
| The host | has no such file and no `/sandboxes` directory |
| A path outside every sandbox | refused (`SANDBOX_NO_ROUTE`) |
| `..` from A into B's folder, and an absolute path into B asked from A | refused (`SANDBOX_CROSS_ROUTE`) |
| A command whose working directory is outside every sandbox | refused |
| 40 interleaved writes and reads across the two threads | each thread reads back only its own content |
| Exit codes | returned (`7`) |

What it taught:

- **Routing works by working directory.** `resolve(path, { cwd })` and `spawn({ cwd })` both carry it, so one
  provider can serve every thread.
- **The router is the boundary between threads.** The first version of the script routed `..` from A into B's
  folder to B. The seams carry a path, not a Session, so the provider must refuse a path that leaves the
  sandbox of the working directory it was asked from. That check is now in the script and tested.
- **`resolveExecutable(command, env)` and `terminalEnvironment()` carry no working directory.** The spike
  returns the bare command and lets the guest resolve it at spawn. Whether core's bash executor accepts that is
  not verified.
- **Cordis serves a service through a Proxy,** so a provider class cannot use `#private` members.
- **`docker exec` per call is too slow for real use:** about 1.5 s per write-then-read under 40 concurrent
  operations (three `docker exec` each); one sequential `docker exec` takes 86 ms at p50 here. A provider needs one
  long-lived guest agent per sandbox and a stream to it.
- Container start: about 150 to 180 ms each here.

Read from core afterwards, which lowers two of the unknowns:

- The core file tools pass the thread's working directory: `dsh-tool-fs` calls
  `fs.resolve(path, await sessionResolveOptions(ctx, exec))` at each of its three resolve sites.
- The core bash executor spawns with `cwd: spec.workdir` through `subprocess.spawn`.
- Core packages that reach `ctx.subprocess`, and would therefore run in the sandbox: `dsh-bash-local`,
  `dsh-pwsh-local`, `dsh-shell`, `dsh-terminal-bash`, `dsh-tool-fs-search` (core's grep and glob),
  `dsh-workspace-changes`, `dsh-ptc-runtime-node`, `dsh-experimental-worktree`, `dsh-host-open-in-app`.

Not covered by this spike: core's own tools running on top of these providers in a real turn (whether they
always pass the thread's `cwd`), terminal sessions, background jobs, file watching, `editText`, and the
guest agent.

## Spikes still to run

| Spike | Where | State |
| --- | --- | --- |
| S2 (A: multi-host mirrors a second local runtime) | here | not run |
| S12 (B: one fs + subprocess provider routing two threads to two containers) | here, with Docker | seam-level routing proven; a real turn through core's tools not yet |
| S4 custom model base URL | here | not run |
| S11 hardened container runs the guest | here | container start proven; guest not yet |
| S1, S5–S10 | Fedora 44 machine | not run |
