# Sandboxes: isolated parallel agents on any host

Give each agent thread its own sandbox: its files and every command it runs live there, while the agent itself
(the loop, the model calls, the transcript) stays in the user's DSH. The sandbox is a microVM (microsandbox) or a
hardened container (Docker or Podman), on this machine or on a remote one, from a harness that runs on Linux,
macOS or Windows, directly or in Docker.

**Status:** plan; spikes S3 and S12 done. No plugin built yet.

**Resume here:** spike S13 (a real turn through core's tools on the routed providers), then P1.

| Phase | Deliverable                                                          | Where it is tested                       | State       |
| ----- | -------------------------------------------------------------------- | ---------------------------------------- | ----------- |
| P0    | Feasibility spikes and decisions                                     | here; Fedora for KVM                     | in progress |
| P1    | Routed providers, orchestrator, directory provider (no isolation)    | here                                     | not started |
| P2    | Guest agent and its protocol                                         | here, with Docker                        | not started |
| P3    | Project in, changes back out (git sync), egress, command credentials | here, with Docker                        | not started |
| P4    | Container provider (Docker, Podman)                                  | here (Docker); Podman on Fedora          | not started |
| P5    | Seam coverage: every tool runs in the sandbox or is refused          | here                                     | not started |
| P6    | microsandbox provider on Linux, macOS and Windows                    | Fedora; macOS and Windows when available | not started |
| P7    | Evaluation of the two providers, and the default                     | Fedora                                   | not started |
| P8    | Harness in Docker, and sandboxes on a remote machine                 | here with Docker; Fedora                 | not started |
| P9    | UI, agent tools, telemetry, docs                                     | here                                     | not started |
| P10   | Optional: Firecracker provider for dense Linux hosts                 | Fedora                                   | not started |

## 1. What we want

1. **Isolation.** Several agents work at once on one machine. No agent can read or change another agent's files,
   processes, network traffic or credentials, nor the machine's own.
2. **Three topologies.** The harness on the machine itself (T1), the harness in Docker (T2), the sandboxes on
   another machine (T3).
3. **Three operating systems.** Linux, macOS and Windows.
4. **Two providers, the user's choice.** A microVM (microsandbox) and a container (Docker or Podman), each
   labelled with the isolation it really gives.
5. **Fast.** At most 2 s from "create" to the first prompt accepted.
6. **Sandbox by default.** A new thread runs in a sandbox. When no provider is ready, it runs as today with a
   "Not sandboxed" badge.
7. **The project goes in, the changes come back,** without giving the sandbox a way to write to the host.
8. **The model key never enters a sandbox.**
9. **Provider-neutral.** A new provider is one package.
10. **Stock DSH.** No core patch.

Out of scope: a hosted multi-tenant service, GPU passthrough, Windows or macOS guests, live migration.

## 2. The architecture, and why

### 2.1 Brain on the host, hands in the sandbox

DSH core already splits an agent's work into replaceable services ("capability seams"):

| Seam             | Loader row today                      | What goes through it                                                               |
| ---------------- | ------------------------------------- | ---------------------------------------------------------------------------------- |
| `ctx.fs`         | `dsh-fs-sandbox`                      | every file read, list, write and edit of the core file tools                       |
| `ctx.subprocess` | our fork `@dshfiles/subprocess-local` | every command: bash, pwsh, terminals, background jobs, MCP servers, core grep/glob |
| `ctx.sandbox`    | `dsh-sandbox-local`                   | same-world confinement (bubblewrap, Landlock, Seatbelt, Windows ACL) of commands   |

Core's own documentation names this as the route: `ctx.sandbox` is "same-world confinement only — containers,
microVMs, and remote execution require replacing capability implementations", and "remote compositions replace
all three providers" ([P0 findings, S3](P0-findings.md)).

So we replace the three rows with **routed providers**. For a thread that runs in a sandbox, each call goes to
that thread's sandbox; for any other thread, the call goes to the stock local implementation, unchanged.

```
user's DSH (agent loop, model calls, transcript, UI)
  ctx.fs / ctx.subprocess / ctx.sandbox  ──►  routed providers (@dshfiles/sandboxes)
        │ thread in a sandbox                          │ thread not in a sandbox
        ▼                                              ▼
  guest agent in the thread's sandbox            stock local providers (as today)
  (microVM or container: project files, commands, toolchain)
```

### 2.2 Why this and not a whole runtime per sandbox

The alternative (A) runs a full DSH in each sandbox and mirrors its thread through multi-host.

|                         | **B. Routed seams (chosen)**                                      | A. Runtime in each sandbox                                               |
| ----------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Start                   | the sandbox (about 150 ms for a container here) plus the project  | the sandbox plus a DSH boot (about 8 s of CPU for the full web profile) |
| Memory per idle sandbox | the guest agent                                                   | a runtime, about 300 MB                                                  |
| Model key               | never leaves the host                                             | needs a proxy to stay out                                                |
| Image                   | any image with the project's toolchain                            | must carry Node, DSH and our bundles                                     |
| Thread in the UI        | an ordinary local thread                                          | a mirrored remote thread, with its limits                                |
| Weak point              | anything that bypasses the seams runs on the host (section 3.7)   | none for the agent                                                       |
| Proven                  | per-thread routing, 12/12 checks (S12)                            | not tried                                                                |

### 2.3 How this compares with Claude Code

Read from Claude Code's sandboxing documentation on 2026-11-15:

- Same principle: the agent process runs on the host; only the commands it runs are confined, with a proxy and a
  host allowlist for the network, and secrets that can be masked and substituted by the proxy.
- Claude Code confines **only shell commands**, with bubblewrap (Linux, WSL2) or Seatbelt (macOS), on the host
  kernel. File edit tools, MCP servers and hooks run outside the sandbox; reads of most of the machine are
  allowed by default. DSH core's `dsh-sandbox-local` is the equivalent today.
- For a single boundary around everything, Claude Code's documentation recommends running the whole process in
  a container or VM.

B goes further than Claude Code's default: file tools and MCP servers go into the sandbox too, and the boundary
is a separate VM or container, not confinement on the host kernel.

### 2.4 Facts this plan stands on

- Core file tools resolve every path with the thread's working directory
  (`fs.resolve(path, await sessionResolveOptions(ctx, exec))`); the core bash executor spawns with
  `cwd: spec.workdir`. A routed provider can therefore find the thread from the working directory (S12).
- Core packages that reach `ctx.subprocess`: `dsh-bash-local`, `dsh-pwsh-local`, `dsh-shell`,
  `dsh-terminal-bash`, `dsh-tool-fs-search`, `dsh-workspace-changes`, `dsh-ptc-runtime-node`,
  `dsh-experimental-worktree`, `dsh-host-open-in-app`. The MCP client starts servers through it too.
- The seams carry a path, not a Session. The routed provider is the boundary between threads: it must refuse a
  path that leaves the sandbox of the working directory it was asked from (S12 caught the first version
  routing `..` into another thread's sandbox).
- `resolveExecutable(command, env)` and `terminalEnvironment()` carry no working directory (section 3.2).
- Cordis serves a service through a Proxy: a provider class cannot use `#private` members (S12).

Provider facts (read from each project's pages on 2026-11-14; to verify in P0):

|                         | microsandbox                                                                                | Docker or Podman containers                             |
| ----------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Boundary                | microVM with its own kernel                                                                 | namespaces and cgroups on a shared kernel               |
| Linux / macOS / Windows | KVM / Apple silicon only / native through Windows Hypervisor Platform (one review says WSL2) | yes / in the engine's VM / in WSL2 or the engine's VM   |
| Without a hypervisor    | no                                                                                          | yes                                                     |
| Runs                    | library and CLI, no daemon, TypeScript SDK                                                  | daemon (Docker) or daemonless (Podman)                  |
| Images                  | OCI                                                                                         | OCI                                                     |
| Network                 | built-in egress allowlist                                                                   | internal network plus our proxy                         |
| Maturity                | beta, breaking changes expected; Apache-2.0                                                 | mature                                                  |

Environments: this cloud session is root, has Docker 29 (started by hand) and no `/dev/kvm`. The reference
machine for final tests is the user's Fedora 44, x86_64, 16 GB.

## 3. Design

### 3.1 Components

| Package                            | Role                                                                                                                  | Depends on                                         |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `@dshfiles/sandbox-provider-port`  | The contract a provider implements, as a dshx module.                                                                 | dshx                                               |
| `@dshfiles/sandboxes`              | Orchestrator and the three routed providers: records, lifecycle, routing, git sync, proxy, page, tools.               | the port, sqlite-store, the stock local providers |
| `@dshfiles/sandbox-guest`          | The guest agent that runs in every sandbox, and its protocol.                                                         | none at run time                                   |
| `@dshfiles/sandbox-container`      | Docker or Podman provider, hardened.                                                                                  | the port                                           |
| `@dshfiles/sandbox-microsandbox`   | microsandbox provider, through its TypeScript SDK at a pinned version.                                                | the port                                           |
| `@dshfiles/sandbox-directory`      | Test provider: a plain host directory and local processes. No isolation; used by tests and to develop without engine. | the port                                           |
| `tooling/sandbox-image`            | The default OCI image: a common toolchain (git, Node, Python, build tools) and the guest agent, x86_64 and aarch64.   | none at run time                                   |

`@dshfiles/sandboxes` takes the Loader rows `fs`, `subprocess` and `sandbox` in the profile (the supported way to
replace a native row: [native plugin overrides](../../docs/native-plugin-overrides.md)). For threads outside a
sandbox it delegates to the same implementations those rows use today, so turning sandboxes off changes nothing.

### 3.2 The routed providers

- **Routing key:** the thread's working directory. Each sandboxed thread gets a working directory under a
  reserved root (for example `<DSH home>/sandboxes/<thread>/workspace`) that exists only as a name on the host.
  A call whose path or `cwd` is under that root goes to the thread's sandbox.
- **Boundary:** a path is resolved against the asking `cwd`, normalized, then refused (`SANDBOX_CROSS_ROUTE`) if
  it lands in another sandbox or outside the asking sandbox. A sandboxed thread cannot reach host paths through
  the seams at all.
- **`ctx.fs`:** every method of core's `FileSystem` is forwarded to the guest agent, including `editText` as a
  native compare-and-edit, `watch`, byte ranges and streaming. Target keys are `<sandbox>:<guest path>`.
- **`ctx.subprocess`:** `spawn` and `spawnTerminal` open a stream to the guest agent, which runs the process
  there and returns stdout, stderr, the control channel and the exit facts. Termination and `waitForExit` reach
  the whole process group in the guest.
- **`ctx.sandbox`:** inside a sandbox the boundary is the sandbox itself. The provider answers the core modes
  honestly: `read-only` and `workspace-write` are still enforced in the guest (the guest agent applies them),
  and the reported enforcement says "sandbox: microvm" or "sandbox: container".
- **No working directory:** `resolveExecutable` and `terminalEnvironment` cannot be routed. The provider returns
  the bare name and the guest's environment description, and resolution happens in the guest at spawn. S13
  checks that core's executors accept this.

### 3.3 The guest agent

One small program per sandbox, started as the sandbox's first process.

- Serves one multiplexed stream to the host: file operations, process start and I/O, terminals, watches,
  readiness, git snapshot (section 3.4), shutdown.
- Runs everything as a non-root user, and enforces the `read-only` / `workspace-write` mode per call.
- Is the only thing the image must contain besides the toolchain. Form decided in S14: a single static binary
  (works in any image) is preferred over a Node script (needs Node in the image).
- The protocol is versioned; the host refuses a guest agent it does not know.

Budget: one file operation round trip under 5 ms on the same machine (S12 measured 86 ms per `docker exec`,
which is why a long-lived agent is needed).

### 3.4 The project goes in, the changes come back

The setting `workspace.mode`, per project. Default: the safest.

| Mode                 | In                                                           | Back                                             | What the sandbox can do to the host        |
| -------------------- | ------------------------------------------------------------ | ------------------------------------------------ | ------------------------------------------ |
| **`copy`** (default) | a git bundle of the base revision, plus files the user picks | git: the host fetches a snapshot after each turn | nothing                                    |
| `mount-readonly`     | the folder mounted read-only, writes in a layer inside       | git, as in `copy`                                | read every file in the folder              |
| `mount`              | the folder mounted read-write                                | already there                                    | change any file in the folder at any time  |

A writable mount is not the default because it protects the machine but not the project: an agent could
rewrite `.git/hooks`, a `package.json` script or an `.envrc`, which then runs on the host with the user's rights,
and read a `.env` in the folder.

`copy` in detail:

1. **In.** At create, the orchestrator bundles the base revision; the guest agent clones from it. Untracked
   files are copied only when the user picks them. Ignored folders (`node_modules`, build output) are rebuilt.
2. **Back, after every turn.** The Host knows when a turn ends. It asks the guest agent for a snapshot: the whole
   working tree, untracked files included, committed on a per-sandbox ref, sent as a git pack.
3. **On the user's machine.** The host fetches it into the user's repository as `sandbox/<thread>` and refreshes
   a **thread workspace** (a jj workspace or git worktree, as dshfiles already creates per thread). The files are
   on disk, a turn behind at most. The user's own checkout is never touched.
4. **Landing.** The existing Land flow.

Safety: a git fetch carries objects only; hooks, configuration and credentials do not travel. The host checks
objects, refuses unrequested submodule and filter changes, and runs nothing from the fetched tree.

Other files (logs, screenshots, build output): `sandbox_export`, bounded, into a folder the user names.

### 3.5 Network: deny by default

- **Egress:** an allowlist per sandbox (package registries and the repository's forge by default). Denials are
  logged with the sandbox id. microsandbox enforces it itself; containers sit on an internal network whose only
  exit is the orchestrator's proxy.
- **Inbound:** only the guest agent's stream, on the host's loopback. A dev server is reached through an explicit
  per-port forward.
- **Between sandboxes:** no route.

### 3.6 Credentials

- **The model key** stays on the host by construction: the agent loop runs there.
- **Credentials a command needs** (a registry token, a forge token for `git fetch`) are never written into the
  sandbox. The proxy holds them as `secret:ALIAS` references, resolved on the host, and adds them to requests to
  the one host each is bound to; the command sees a placeholder. microsandbox has the same feature built in.
- **Pushing** happens on the host when the user lands, never from the sandbox.

### 3.7 Seam coverage: what would escape

Anything that touches project files or starts processes without going through the three seams would run on the
host for a sandboxed thread. Known from the S3 grep (to complete in P5):

| Owner                      | What it does directly                        | Plan                                                                                                                      |
| -------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `@dshfiles/fff-search`     | grep and glob from a host-side index         | route through `ctx.subprocess` in the sandbox, or refuse for sandboxed threads (core grep/glob already use the seam)      |
| `@dshfiles/jj-integration` | spawns `jj` and `git` on the thread workspace | runs on the host-side thread workspace of section 3.4, the user's copy: allowed, since it never executes project code    |
| `@dshfiles/project-checks` | spawns check commands                        | must run in the sandbox: route through `ctx.subprocess`                                                                   |
| `@dshfiles/pull-requests`  | spawns `gh`                                  | runs on the host on purpose (needs the user's credentials); never on sandbox files                                        |
| other plugins with tools   | to inventory                                 | route, or refuse for sandboxed threads                                                                                    |

P5 turns this into a test (C6): every agent tool in the web profile is listed, and for a sandboxed thread each
either goes through the routed seams, is declared host-only with a reason, or is refused.

### 3.8 Lifecycle and records

Records live in a plugin-owned SQLite store (`sqlite-store`, deferred open, bounded WAL).

```
requested → preparing → starting → ready ⇄ paused → stopping → stopped → destroyed
                 └──────────┴────────┴──────────────► failed(reason, recovery)
```

- One span and one row update per transition; resumable after a crash.
- **Reconciliation** at Host start and every minute against `provider.list()`: an instance with no record is
  destroyed; a record with no instance becomes `failed(lost)`.
- **Quotas per host:** sandboxes, vCPU, memory, disk. Over quota is refused with the numbers.
- **Retention:** `retention.stoppedHours`, default 24, per host, overridable per sandbox, `0` = destroy at stop.
  Destroying a sandbox with an un-fetched snapshot requires an explicit opt-in.
- **One sandbox per thread,** created at the thread's first tool call that needs it, or ahead from the warm pool.

### 3.9 Providers

**Choice:** the setting `provider`, per host: `auto` (default), `microsandbox` or `container`. `auto` takes the
microVM when the host can run one, otherwise the container, and says so on the thread. Never changed silently.

| Machine                                  | microsandbox | container             |
| ---------------------------------------- | ------------ | --------------------- |
| Linux with KVM (the Fedora reference)    | yes          | yes                   |
| Linux without KVM (this cloud session)   | no           | yes                   |
| macOS, Apple silicon                     | yes          | yes, in the engine VM |
| macOS, Intel                             | no           | yes, in the engine VM |
| Windows with Windows Hypervisor Platform | yes          | yes, in WSL2          |

**Container hardening:** rootless recommended (a rootful engine works with a warning and how to switch), all
capabilities dropped, `no-new-privileges`, default seccomp, a user namespace, read-only root with a size-limited
writable layer, process, memory and CPU limits, no host socket or device. On Linux, `container.runtime` can
select gVisor or Kata.

**Provider port:**

| Method                                       | Result                                                          |
| -------------------------------------------- | --------------------------------------------------------------- |
| `describe`                                   | id, version, capabilities, readiness with reasons               |
| `prepareImage`                               | local image id, size, checksum                                  |
| `create`, `start`                            | a handle, then a `GuestChannel`: the stream to the guest agent  |
| `stop`, `destroy`, `inspect`, `list`, `logs` | lifecycle and facts                                             |
| `snapshot`, `restore`                        | when declared                                                   |

Capabilities: `isolation` (`microvm` or `container`), `snapshot`, `pause`, `readOnlyMount`, `writableMount`,
`egressAllowlist`, `secretInjection`, `architectures`. Every failure is a typed error with a recovery sentence.

### 3.10 Topologies

|                                     | Where sandboxes run                                                                                                                                        | How the routed providers reach the guest agent                                                                     |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **T1** harness on the machine       | same machine                                                                                                                                               | the provider's channel (a loopback port or a socket)                                                               |
| **T2** harness in Docker            | Linux: microsandbox in the harness container with `--device /dev/kvm`, or containers through rootless Podman inside it; the host engine's socket only as a labelled opt-in | same as T1                                                                                    |
| **T3** sandboxes on another machine | a remote host running DSH with `sandboxes`                                                                                                                 | the thread is a multi-host remote thread on that host, and that host's routed providers use its local sandboxes |

T3 needs no new transport: multi-host already runs a thread on another machine; that machine sandboxes it like
T1. The git snapshot of section 3.4 travels through multi-host's existing connection to the user's machine.

### 3.11 What the user and the agent see

- **New thread:** sandbox by default (`isolation.default`: `sandbox` or `workspace`). With no provider ready the
  thread runs as today, with a "Not sandboxed" badge linking to `sandbox_doctor`
  (`isolation.whenUnavailable`: `workspace` default, `ask`, `refuse`).
- **Thread header:** "Sandbox · microVM" or "Sandbox · container", the workspace mode when not `copy`, and the
  host thread workspace where the changes land.
- **Sandboxes page** (palette and New tab chooser): host, provider, isolation, state, thread, CPU, memory, disk,
  age; Stop, Start, Export, Destroy, Logs. Works at 390 px.
- **Agent tools:** `sandbox_list`, `sandbox_inspect`, `sandbox_logs` (read-only); `sandbox_create`,
  `sandbox_start`, `sandbox_stop`, `sandbox_export`, `sandbox_set_retention` (only when the user asked);
  `sandbox_destroy` with a required `confirmDestroy`.
- **`sandbox_doctor`:** per provider, why the host cannot run it and the exact fix.

### 3.12 Start under 2 seconds

The sandbox start (about 150 ms for a container here, under 100 ms reported for microsandbox) plus the project
load (a git bundle clone). No DSH boots in the sandbox. A warm pool of one ready sandbox per host remains
available if the project load is what misses the budget.

## 4. Phases

Each phase ends with an exit gate. A phase does not start before the previous gate is met.

### P0. Spikes and decisions

| Spike  | Question                                                                                                                         | Where                                    | State                                        |
| ------ | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | -------------------------------------------- |
| S3     | Where do core's file and process work run?                                                                                       | here (read)                              | done: the three seams, [findings](P0-findings.md) |
| S12    | Can one provider per seam route each thread to its own sandbox?                                                                  | here, Docker                             | done: 12/12                                  |
| S13    | Does a real turn work on routed providers: core's file tools, bash, grep/glob, a background job, a terminal, an MCP server?     | here, Docker, fake model                 |                                              |
| S14    | Guest agent: form (static binary or Node), protocol, round-trip time                                                             | here, Docker                             |                                              |
| S1     | microsandbox on the Fedora machine: start time, channel to a guest agent                                                         | Fedora                                   |                                              |
| S4     | Command credentials through the proxy (placeholder replaced on the bound host only)                                              | here                                     |                                              |
| S5     | Harness in Docker: what each provider needs, without `--privileged`                                                              | here (containers); Fedora (microsandbox) |                                              |
| S7     | `git`, `pnpm install` and `pip install` through the allowlist; a non-listed host refused                                         | here                                     |                                              |
| S8, S9 | microsandbox on Windows and macOS                                                                                                | when a machine is available              |                                              |
| S10    | Read-only mounts hold against root in the guest                                                                                  | here (containers); Fedora (microsandbox) |                                              |

**Exit gate:** S13 and S14 pass, and `P0-findings.md` records every spike's command, numbers and verdict.

### P1. Routed providers, orchestrator, directory provider

1. `@dshfiles/sandbox-provider-port`: schemas, capabilities, typed errors, contract tests.
2. `@dshfiles/sandboxes`: the three routed providers (delegating to the stock ones for other threads), records,
   state machine, reconciliation, quotas, retention, settings.
3. `@dshfiles/sandbox-directory`: the no-isolation provider for tests.
4. Profile composition: the three rows replaced; the web profile seed unchanged until P9.

**Exit gate:** with the directory provider, a scratch DSH runs a fake-model turn in a sandboxed thread (file
edit, bash, grep) next to an unsandboxed one; the unsandboxed thread behaves exactly as before (its existing
e2e journeys pass); the cross-route tests pass.

### P2. Guest agent

`@dshfiles/sandbox-guest`: the form chosen in S14, the protocol, file operations, processes, terminals, watches,
mode enforcement, git snapshot.

**Exit gate:** the port's contract tests pass with the guest agent in a container; round trip under 5 ms.

### P3. Project in, changes back out, egress, command credentials

`copy` mode end to end; `mount-readonly` and `mount` as opt-ins; egress allowlist with denial log; the
credential proxy.

**Exit gate:** tests W1–W4, I7, I8 pass with Docker here.

### P4. Container provider

Docker and Podman detection, hardening, internal network, `container.runtime`, readiness reasons.

**Exit gate:** with Docker here and Podman on Fedora, the port's contract tests, the P1 gate and tests I1–I9 pass,
or are recorded as "not provided by containers" with the reason.

### P5. Seam coverage

The inventory of section 3.7, completed; each tool routed, declared host-only with a reason, or refused for
sandboxed threads.

**Exit gate:** test C6 passes over the full web profile.

### P6. microsandbox provider

Through the TypeScript SDK at a pinned version: readiness, image, create, start, guest channel, limits, logs,
stop, destroy, snapshot.

**Exit gate:** on the Fedora machine, a committed report shows the contract tests, the P1 gate, I1–I9 and C5
passing. macOS and Windows rows stay "not verified" until a machine is available.

### P7. Evaluation

The whole suite and the budgets with both providers on the Fedora machine (containers also here), into
`evaluation.md` (section 5.2). Decide with the user what `auto` prefers.

### P8. Harness in Docker, and remote sandboxes

T2 compose files and the flags from S5; T3 through multi-host with a remote host that runs `sandboxes`.

**Exit gate:** the P4 gate passes with the harness in a container; a remote thread on a second machine runs in a
sandbox there and its changes arrive in a thread workspace on the user's machine.

### P9. UI, tools, telemetry, docs

The page, badges, settings, `sandbox_doctor`, screenshots, feature catalog with a span per transition and an
`onboarding` block, pack entry, READMEs, `docs/sandboxes.md`, the web profile seed, `complete-plan`.

**Exit gate:** `check:screenshots`, `features:check`, the boot check and one browser journey per package.

### P10. Optional: Firecracker

Only if P7 shows a need for density on Linux hosts.

## 5. How we know it works

Automated in `plugins/@dshfiles/sandboxes/tests/acceptance/`, against each provider. The last column says what
is expected of containers, so a weaker result is recorded, never hidden.

| Id  | Claim                                  | Pass when                                                                                  | Containers                       |
| --- | -------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------- |
| I1  | A cannot read B's files                | a marker written in B is not found from A                                                  | must pass                        |
| I2  | A cannot read the host's files         | no host marker found; no host path visible                                                 | must pass                        |
| I3  | A cannot see other processes           | only its own                                                                               | must pass                        |
| I4  | A cannot reach the host's DSH          | refused                                                                                    | must pass                        |
| I5  | A cannot reach B                       | refused                                                                                    | must pass                        |
| I6  | Limits hold (fork bomb, memory, disk)  | A contained; B and the host's `host-lag` within 20 %                                       | must pass                        |
| I7  | Egress is allowlisted                  | allowed host works, other refused and logged                                               | must pass                        |
| I8  | No real credential in the guest        | the model key and every proxied token absent from guest memory and disk                    | must pass                        |
| I9  | Cross-route refused                    | a path or `cwd` from A into B's root, or onto the host, is refused at the seam             | must pass                        |
| K1  | Own kernel                             | A, B and host kernels differ                                                               | expected to fail: "shared kernel" |
| K2  | Root in the guest stays there          | known escapes fail; a rootful engine is also warned                                        | must pass                        |
| W1  | Changes come back                      | tracked and untracked edits are in the host thread workspace after the turn                | must pass                        |
| W2  | The user's checkout is untouched       | checkout, `.git` config and hooks identical before and after                               | must pass                        |
| W3  | Nothing executable crosses             | a hook, `.gitmodules` entry or filter written in the guest has no effect on the host       | must pass                        |
| W4  | Mount modes are honest                 | root in the guest cannot write a read-only mount; no host path in `copy`                   | must pass                        |
| L1  | Crash recovery                         | after `kill -9` of the Host, ready sandboxes reattach, starting ones are cleaned, no orphan | must pass                        |
| L2  | No leak                                | 200 create/destroy cycles return to baseline ±5 %                                          | must pass                        |
| L3  | Destroy is guarded                     | refused without `confirmDestroy` when a snapshot is not fetched                            | must pass                        |
| C1  | Parallelism                            | 8 sandboxed threads run 20-step turns at once, no cross-talk, `host-lag` p99 < 250 ms      | must pass                        |
| C2  | Unsandboxed threads unchanged          | the existing e2e journeys pass with the routed providers installed                         | must pass                        |
| C3  | Provider neutrality                    | the contract suite passes for directory, container and microsandbox                        | must pass                        |
| C4  | Operating systems                      | the provider gate on each available system                                                 | must pass                        |
| C5  | Start time                             | 50 creates, p95 create → first prompt accepted ≤ 2 s                                       | must pass                        |
| C6  | Seam coverage                          | every agent tool is routed, host-only with a reason, or refused                            | must pass                        |
| D1  | Sandbox by default                     | default thread is sandboxed; with no provider it runs with the "Not sandboxed" badge       | must pass                        |
| D2  | Retention is configurable              | 1 h per host and 0 per sandbox are honoured; default 24 h                                  | must pass                        |
| D3  | Provider never changes silently        | the thread names its provider; a fallback is visible                                       | must pass                        |

### 5.1 Who runs what

| Where                                      | What                                                                                                                                                                                                 |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Here (cloud session, root, Docker, no KVM) | everything with the directory and container providers: P1–P5, P8 (T2 with containers), the UI, and every test above except K1 for microVMs and C4 beyond Linux                                       |
| The user's Fedora 44                       | the final runs: microsandbox, Podman, rootless engines, budgets, C4 on Linux; `node scripts/sandbox-acceptance.mjs --provider <name>` writes `reports/<date>-<os>-<provider>.md`, committed       |
| macOS, Windows                             | when a machine is available                                                                                                                                                                          |

### 5.2 Evaluation matrix (P7)

One column per provider and engine; rows: isolation tests passed and "not provided", start p50/p95, memory per
idle sandbox, sandboxes at once before `host-lag` breaks, disk per sandbox, time for a 50-file change to reach
the host, setup steps, failures over 200 cycles.

## 6. Budgets

| Measure                                             | Target             |
| --------------------------------------------------- | ------------------ |
| Create → first prompt accepted, p95                 | ≤ 2 s              |
| Guest agent file round trip, same machine           | ≤ 5 ms             |
| Changes in the host thread workspace after a turn   | ≤ 3 s for 50 files |
| Host overhead per idle sandbox                      | ≤ 30 MB            |
| Idle sandbox CPU on the host                        | ≤ 0.5 % of a core  |
| Disk per sandbox before work                        | ≤ 50 MB            |
| Sandboxed threads on the 16 GB reference machine    | 8 active           |

## 7. Risks

| Risk                                                        | Mitigation                                                                                                     |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| A tool bypasses the seams and runs on the host              | C6 inventory and test; refuse by default what is not routed                                                    |
| A path trick crosses between sandboxes                      | the routed provider normalizes and refuses; I9 and the S12 cases                                               |
| Core calls a seam without a working directory               | S13 and C2; route by target key once resolved                                                                  |
| Replacing the three native rows breaks unsandboxed threads  | delegate to the stock providers; C2 runs the existing journeys                                                 |
| microsandbox beta changes                                   | pinned version, contract suite on every bump, containers as the alternative                                    |
| Its Windows or macOS support is not as advertised           | S8, S9; containers cover the gap, labelled                                                                     |
| Container mistaken for a microVM                            | the `isolation` capability on every surface; D3                                                                |
| A writable mount enabled without seeing the consequence     | off by default, per project, a permanent badge and the explanation                                             |
| Git sync misses files the user expects                      | untracked files included; `sandbox_export`; `mount-readonly`                                                   |
| A DSH release changes a seam                                | the routed providers implement core's abstract classes; their contract tests run on each upgrade (`dsh-lkg`)   |

## 8. Decisions taken

| Date       | Topic               | Decision                                                                                        |
| ---------- | ------------------- | ----------------------------------------------------------------------------------------------- |
| 2026-11-14 | Systems             | Linux, macOS, Windows                                                                           |
| 2026-11-14 | Providers           | microsandbox and Docker/Podman, both built and evaluated; Firecracker optional                  |
| 2026-11-14 | Start               | ≤ 2 s                                                                                           |
| 2026-11-14 | Project files       | copied in, changes back through git; mounts are opt-in                                          |
| 2026-11-14 | Network             | denied by default, allowlist                                                                    |
| 2026-11-14 | Default             | sandbox; with no provider, run as today with a badge                                            |
| 2026-11-14 | Retention           | 24 h default, configurable                                                                      |
| 2026-11-14 | Rootless containers | recommended, warned otherwise                                                                   |
| 2026-11-14 | Testing             | as much as possible here; final tests on the user's Fedora 44                                   |
| 2026-11-15 | Architecture        | B: routed `ctx.fs`, `ctx.subprocess` and `ctx.sandbox`; the agent stays on the host             |

## 9. Still open

1. macOS and Windows test machines.
