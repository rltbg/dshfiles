# MicroVM sandboxes: isolated parallel agents on any host

Run each agent thread in its own microVM, on this machine or on a remote one, from a harness that runs on Linux,
macOS or Windows, directly or in Docker. The first provider is a microVM runtime that runs natively on all
three systems (microsandbox, built on libkrun). A hardened container provider is the fallback where no
hypervisor is available. Firecracker comes later, for dense Linux hosts. The hypervisor sits behind a port.

**Status:** plan only. Nothing is built. Statements marked _(verify in P0)_ are assumptions that the first phase
must confirm or replace before any later phase starts.

**Resume here:** Phase 0, spike S1.

| Phase | Deliverable                                                    | Where it is tested                    | State       |
| ----- | -------------------------------------------------------------- | ------------------------------------- | ----------- |
| P0    | Feasibility spikes and decisions                               | local Linux, Mac and Windows machines | not started |
| P1    | Provider port, orchestrator, fake provider                     | here                                  | not started |
| P2    | Project in, changes back out (git sync), credentials, egress   | here with the fake provider           | not started |
| P3    | Container fallback provider (Docker, Podman)                   | here if the Docker daemon runs        | not started |
| P4    | microsandbox provider on Linux, macOS and Windows, 2 s start   | local machines                        | not started |
| P5    | Harness in Docker                                              | local Linux machine                   | not started |
| P6    | Sandboxes on a remote machine                                  | here with fake; local for the rest    | not started |
| P7    | UI, agent tools, telemetry, docs                               | here                                  | not started |
| P8    | Density: warm pool sizing, pause on idle                       | local machines                        | not started |
| P9    | Firecracker provider for Linux hosts                           | local Linux machine                   | not started |

## 1. What we want

1. **Isolation.** Several agents work at once on one machine. No agent can read or change another agent's files,
   processes, network traffic or credentials, nor the machine's own.
2. **Three topologies, one behaviour.**
   - **T1 bare host:** the harness runs directly on a Linux machine and starts microVMs there.
   - **T2 Docker:** the harness runs in a container and still starts and reaches microVMs.
   - **T3 remote:** the harness runs anywhere and the microVMs run on another machine.
3. **Three operating systems.** Linux, macOS and Windows. One microVM technology for all three is preferred
   over one per system. A container is the accepted fallback where no hypervisor is available, and is labelled
   as weaker isolation.
4. **Fast.** At most 2 s from "create" to the first prompt accepted, on every platform.
5. **Sandbox by default.** A new thread runs in a sandbox unless the user chooses otherwise.
6. **The project goes in, the changes come back.** The agent works on the user's project inside the sandbox,
   and the user finds the modifications on their own machine, without giving the sandbox a way to write to
   the host.
7. **It composes with multi-host.** One harness reaches several machines; each machine can run several sandboxes.
8. **Provider-neutral.** microsandbox first, containers as fallback, Firecracker later. Adding a provider means writing one package, not touching the
   orchestrator, the UI or multi-host.
9. **Stock DSH.** No core patch, as everywhere in this repository.

Out of scope: a hosted multi-tenant service, GPU passthrough, Windows or macOS guests, live migration between
machines.

## 2. Facts this plan stands on

From this repository:

- A remote thread is already "a Session of another runtime, mirrored into this Host"
  ([multi-host limits](../../plugins/@dshfiles/multi-host/README.md#limits)). List, follow, prompt, cancel, the
  model catalog, uploads and the JJ panel all forward to the runtime that owns the thread.
- multi-host reaches a runtime through a connector: a loopback forward, an SSH tunnel or a pairing link
  (`plugins/@dshfiles/multi-host/src/connectors/`). Every connection re-checks a pinned runtime identity.
- Auto placement already ranks hosts by resource pressure (`resourceSnapshot`) and a per-host weight.
- Thread isolation today is a jj workspace or git worktree per thread, on a shared filesystem, under one OS user.
  That separates work, not agents: any agent can read the others' folders and the user's home.
- Every shell command goes through the forked `subprocess` service
  ([subprocess-local](../../plugins/@dshfiles/subprocess-local/README.md)). File tools, MCP servers and the agent
  loop itself run in the Host process _(verify in P0)_.
- A stock Host costs about 8 s of CPU to boot and settles around 540 MB RSS with the full web composition
  ([performance](../../docs/performance.md)). Both numbers matter for VM start time and density.

Which technology runs where (read from each project's own pages on 2026-11-14; _all to verify in P0_):

| Candidate | Linux | macOS | Windows | Notes |
| --- | --- | --- | --- | --- |
| **microsandbox** (libkrun) | KVM | Apple silicon only | native, through Windows Hypervisor Platform | Apache-2.0, no daemon, TypeScript SDK, boots OCI images, egress allowlist, secrets kept outside the VM, snapshot and fork, read-only host mounts enforced on the host side. Calls itself beta, with breaking changes expected. One third-party review says Windows needs WSL2, against the README. |
| libkrun alone | KVM | Apple silicon only | not upstream (an open fork pull request) | the library under microsandbox |
| QEMU | KVM | yes, Intel included | yes | runs everywhere but is large, slower to start and has the biggest attack surface |
| Firecracker | KVM | no | only inside WSL2 | no shared folders, snapshots, the densest on Linux servers |
| Apple Virtualization | no | yes | no | macOS only |
| Kata Containers, gVisor | yes | no | no | Linux only |
| Docker or Podman containers | yes | yes, inside Docker's own Linux VM | yes, inside WSL2 or Docker's VM | not a microVM: sandboxes share one kernel |

**Choice:** microsandbox is the only candidate that claims native support on the three systems, so it is the
first provider. It is beta, so its version is pinned and it stays behind the port. The container provider covers
what it does not: Intel Macs, machines with virtualization disabled, and hosts that are themselves containers.
Firecracker is added last, for Linux servers where density matters.

Where things are tested: this cloud session has no `/dev/kvm`, so it cannot boot a microVM. It does have the
Docker CLI but its daemon is not running; if it can be started, the container provider is tested here too,
otherwise on a local machine. The microVM parts run on the user's
local machines through one acceptance command that writes a report (section 5.1).

## 3. Design

### 3.1 The central choice: a sandbox is a guest runtime

Each microVM boots a **stock DSH runtime** with a small profile. The control Host treats it as one more
multi-host runtime and mirrors its Sessions, exactly as it does for a remote machine today.

Why this and not "run only the shell commands in the VM":

| Approach                                | What stays outside the VM                                    | Verdict                                                                    |
| --------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------- |
| **Guest runtime** (chosen)              | nothing of the agent: loop, file tools, shell, jobs, MCP     | full isolation; reuses the remote-thread path that already works           |
| Exec-only (swap the subprocess service) | the agent loop, file tools and MCP servers, in the Host      | a file tool or MCP server still reads the host; needs forks of every tool |

Cost of the choice: each sandbox pays a runtime's RAM and boot time. Section 3.11 covers the start time. If P0
shows the guest runtime cannot fit the budgets in section 6, exec-only becomes the fallback and this plan is
revised before P1.

### 3.2 Components

```
control Host (T1 bare, or T2 in Docker)                    sandbox host (same machine in T1/T2, remote in T3)
┌───────────────────────────────────────────┐              ┌──────────────────────────────────────────────┐
│ @dshfiles/sandboxes      orchestrator, UI │── dshx API ──│ @dshfiles/sandboxes   (same package, Host half)│
│ @dshfiles/multi-host     mirrors Sessions │              │ a provider: microsandbox, container, ...      │
│                                           │              │   one microVM or container per sandbox        │
│                                           │── gateway ───│   endpoint ──► guest agent ──► guest runtime  │
└───────────────────────────────────────────┘              └──────────────────────────────────────────────┘
```

| Package                         | Role                                                                                              | Depends on                         |
| ------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `@dshfiles/sandbox-provider-port` | The contract a provider implements, as a dshx module. No behaviour.                              | dshx                               |
| `@dshfiles/sandboxes`           | Orchestrator: records, lifecycle, reconciliation, quotas, egress proxy, model proxy, page, tools. | the port, multi-host, sqlite-store |
| `@dshfiles/sandbox-microsandbox` | microVM provider for Linux, macOS and Windows, through the microsandbox TypeScript SDK.          | the port                           |
| `@dshfiles/sandbox-container`   | Fallback provider: Docker or Podman, hardened; optional gVisor or Kata runtime on Linux.          | the port                           |
| `@dshfiles/sandbox-firecracker` | Later: Firecracker provider for Linux hosts.                                                      | the port                           |
| `@dshfiles/sandbox-fake`        | Test provider: runs the guest runtime as a plain local process in a scratch home.                | the port                           |
| `tooling/sandbox-image`         | Reproducible build of one OCI image (x86_64 and aarch64) with the guest runtime and guest agent.  | none at run time                   |

Dependencies point one way ([plugin boundaries](../../docs/plugin-boundaries.md)): providers know only the port;
`sandboxes` knows the port and multi-host; multi-host knows none of them. multi-host gains one registry module
(`@dshfiles/multi-host/runtime-source`) through which `sandboxes` contributes ephemeral runtimes and a
destination entry; multi-host renders nothing new when `sandboxes` is absent.

### 3.3 The provider port

One dshx contract, versioned, with capability flags so the orchestrator never guesses.

| Method           | Input                                                        | Result                                                         |
| ---------------- | ------------------------------------------------------------ | -------------------------------------------------------------- |
| `describe`       | none                                                         | provider id, version, capabilities, host readiness with reasons |
| `prepareImage`   | image reference                                              | local image id, sizes, checksum                                |
| `create`         | sandbox id, image id, vCPU, memory, disk sizes, drives       | provider handle                                                |
| `start`          | handle                                                       | a `SandboxEndpoint` (below)                                    |
| `stop`           | handle, grace period                                         | exit state                                                     |
| `destroy`        | handle                                                       | freed bytes                                                    |
| `inspect`        | handle                                                       | state, CPU, memory, disk, uptime                               |
| `list`           | none                                                         | every instance the provider can see, recorded or not           |
| `logs`           | handle, byte bound                                           | bounded console tail                                           |
| `snapshot` / `restore` | handle or snapshot id                                  | only when the capability is declared                           |

Capabilities: `snapshot`, `pause`, `vsock`, `nic`, `hotResize`, `nestedOk`, `architectures`, and `isolation`
(`microvm` or `container`), which the UI shows so a weaker fallback is never mistaken for a microVM.

The guest image, the guest agent and everything in sections 3.4 to 3.8 are shared by all providers. A provider
only boots that image and exposes the endpoint.

`SandboxEndpoint` is the only thing the orchestrator needs to reach the guest: a host-side stream factory
(`open(port) → duplex`). Each provider implements it its own way: a port published on the host's loopback only
(microsandbox, containers, the fake provider) or a vsock socket (Firecracker). The orchestrator turns it into a private loopback forward and hands multi-host a normal local launch URL,
so multi-host's existing `connectLocal` path is reused unchanged _(verify in P0)_.

Every failure is a typed error with a recovery sentence (the repository rule for user-facing errors), for
example: `kvm-unavailable` → "This machine has no /dev/kvm. Enable virtualization, or choose a remote sandbox
host under Hosts."

### 3.4 Inside the guest

One **OCI image** serves every provider: microsandbox and containers boot it as is, and the later Firecracker
provider converts it to a root filesystem.

- **Contents:** minimal Linux userland, the Node version from `.node-version`, the pinned DSH core, the built
  dshfiles bundles the `sandbox` profile needs, git and jj, the guest agent. Built for x86_64 and aarch64.
- **Root filesystem:** read-only image layers shared by every sandbox, with a per-sandbox writable layer whose
  size is the sandbox's disk quota. Deleting the sandbox deletes the layer.
- **Guest agent:** a small static binary started first. It starts the DSH runtime bound to the guest's
  loopback, reports readiness, applies start parameters (runtime identity, launch token, proxy addresses),
  commits and pushes the work after each turn (section 3.5), gives a restored snapshot a new identity and
  random seed, and stops the guest cleanly on request.
- **`sandbox` profile:** seeded like `profiles/web` but minimal: multi-host (to be mirrored), the VCS provider,
  the tools an agent needs. No Hosts page, no browser-only bundles. Target: under 300 MB RSS settled.

No secret, account file or host path is ever written into the image. `tooling/sandbox-image` fails its build if
a secret scanner finds one.

### 3.5 The project goes in, the changes come back

The setting `workspace.mode` chooses how, per project. The default is the safest.

| Mode | How the project gets in | How changes get back | What the sandbox can do to the host |
| --- | --- | --- | --- |
| **`copy`** (default) | a git bundle of the base revision, plus files the user picks | git: the host fetches the sandbox's commits | nothing: no host folder is visible |
| `mount-readonly` | the project folder mounted read-only, writes go to a layer inside the sandbox | git, as in `copy` | read every file in the folder, secrets included |
| `mount` | the project folder mounted read-write | already there | change any file in the folder at any time |

Why a writable mount is not the default, although it is the simplest: the sandbox would protect the rest of the
machine but not the project. An agent could rewrite `.git/hooks`, a `package.json` script, a `.envrc` or a CI
file, and that code then runs on the host with the user's rights the next time they commit, install or open a
shell. It could also read a `.env` sitting in the folder. A shared folder is a hole in the wall by design.

How `copy` works, so that the user still finds the modifications on their machine:

1. **In.** At create, the orchestrator bundles the chosen base revision and hands it to the sandbox. The guest
   clones from it. Files outside git (an untracked config, for example) are copied only when the user picks
   them, through the file-selection step multi-host already has for remote threads. Ignored folders
   (`node_modules`, build output) are rebuilt inside the sandbox.
2. **Out, after every turn.** The guest agent records the whole working tree, uncommitted files included, as a
   commit on a per-sandbox ref and pushes it to a bare repository on the sandbox host that only this sandbox can
   reach. Nothing depends on the agent remembering to commit.
3. **On the user's machine.** The host fetches that ref into the user's repository as `sandbox/<thread>` and
   refreshes a **thread workspace** from it: an ordinary jj workspace or git worktree, the same kind dshfiles
   already creates for each thread. The files are there, on disk, a turn behind at most. The user's own
   checkout is never touched.
4. **Landing.** The existing Land flow brings the thread workspace onto `main`, with its usual review.

What makes this safe: a git fetch transfers objects only. Hooks, repository configuration and credentials do
not travel. The host fetches with object checking on, refuses submodule and filter changes it did not ask
for, and never runs anything from the fetched tree. The content itself is still agent-written code, to be
reviewed before it is run, as today.

**Files that are not commits** (logs, screenshots, build output): pulled on request through a bounded
`sandbox_export` call, size-capped, into a host folder the user names.

`mount-readonly` and `mount` exist for projects where copying is impractical (very large repositories, tools
that need the live tree). Each must be turned on per project and shows a badge on the thread. `mount-readonly` is offered only by
providers that enforce read-only on the host side, so a root process in the guest cannot undo it.

### 3.6 Network: deny by default

- **Egress:** closed except for an allowlist per sandbox (package registries and the repository's forge by
  default). Denials are logged with the sandbox id. microsandbox enforces the allowlist itself; the container
  provider attaches the container to an internal network whose only exit is the orchestrator's proxy.
- **Inbound:** nothing, except the one endpoint published on the host's loopback for the orchestrator. A dev
  server in the guest is reached through an explicit, per-port forward the user opens.
- **Between sandboxes:** no route.

### 3.7 Credentials

The agent loop runs in the guest, so it needs to call a model. The real key must not enter the guest.

- **Model proxy (chosen):** the guest's provider is configured with a base URL served by the orchestrator and a
  per-sandbox token. The orchestrator's model proxy validates the token, attaches the real credential resolved
  on the Host through the existing `secret:ALIAS` path, and forwards. Revoking a sandbox revokes its token.
  Requires that the guest's provider configuration accepts a custom base URL _(verify in P0)_.
- microsandbox advertises secrets that never enter the VM and are bound to one allowed host. If S4 shows that
  covers model calls, the provider uses it and the orchestrator's proxy serves the other providers.
- **Fallback:** a short-lived, spend-capped key injected into guest memory at boot. Weaker: the agent can read
  it. Used only if the proxy route is impossible, and flagged in the UI.
- Forge credentials follow the same rule: pushes go to the per-sandbox bare repository on the host; the host,
  not the guest, pushes to the real remote when the user lands the work.

### 3.8 Lifecycle and records

Records live in a plugin-owned SQLite store (`sqlite-store`, deferred open, bounded WAL).

```
requested → preparing → booting → ready ⇄ paused → stopping → stopped → destroyed
                 └──────────┴────────┴──────────────► failed(reason, recovery)
```

- Every transition is one span and one row update; a crash between two steps is resumable from the row.
- **Reconciliation** at Host start and every minute: `provider.list()` against the records. A VM with no
  record is stopped and destroyed; a record with no VM becomes `failed(lost)`. This extends the existing
  [orphan cleanup](../../docs/orphan-cleanup.md).
- **Quotas per host:** maximum sandboxes, total vCPU, total memory, total disk. A request over quota is refused
  with the numbers and what to stop.
- **Retention:** a stopped sandbox keeps its drives so work can still be landed, then is destroyed. The delay
  is the setting `retention.stoppedHours`: default 24, set per host, overridable per sandbox
  (`sandbox_set_retention`), `0` meaning "destroy at stop". Destroying a sandbox with unlanded commits requires
  an explicit opt-in argument.
- **Identity:** each sandbox gets a fresh runtime identity and launch token at create, pinned in multi-host's
  directory like any runtime. A different runtime behind the same endpoint is refused.

### 3.9 Topologies and operating systems

| | Where the provider runs | How the control Host reaches the guest | Host requirements |
| --- | --- | --- | --- |
| **T1 bare** | same Host process | the provider's endpoint, on the host's loopback | a hypervisor (KVM, Apple silicon, Windows Hypervisor Platform), or Docker/Podman for the fallback |
| **T2 Docker** | inside the container | same as T1; the sandboxes are children of the container | Linux host: `--device /dev/kvm` and a volume _(verify in P0)_ |
| **T3 remote** | on the remote machine's own DSH | multi-host connector to the remote Host, then that Host's forward to the guest | the remote machine meets T1; this machine needs nothing |

T3 details:

- The remote machine runs DSH with `multi-host`, `sandboxes` and a provider. The control Host calls the remote
  `sandboxes` API through multi-host's allowlisted remote plugin calls; the allowlist gains exactly the
  `sandboxes` lifecycle methods.
- Reaching the guest: over SSH, one more `-L` to the per-sandbox forward on the remote loopback. Over a pairing
  link, the link gateway gains a **scoped relay** that forwards only to sandbox endpoints the remote
  orchestrator registered. Today's "no relay" limit stays true for everything else.
- T2 with the VMs on the Docker host instead of in the container is simply T3 with the Docker host as the
  remote machine.

A shipped `docker/compose.sandboxes.yml` documents T2: the device, the volume, the user and no extra
capabilities.

Which provider runs where:

| Machine that hosts the sandboxes | Provider | Isolation shown |
| --- | --- | --- |
| Linux with KVM | microsandbox (Firecracker later, as an option) | microVM |
| macOS, Apple silicon | microsandbox | microVM |
| Windows with Windows Hypervisor Platform | microsandbox | microVM |
| Intel Mac, or any machine without a usable hypervisor | container | container, weaker |
| the harness in Docker on macOS or Windows (no KVM inside) | T3 to a host, or a sibling container through the Docker socket, opt-in | microVM, or container, weaker |

The container provider hardens what it can: rootless where available, all capabilities dropped,
`no-new-privileges`, the default seccomp profile, a read-only root with a size-limited writable layer, process,
memory and CPU limits, no host socket or device, a user namespace. On Linux the setting `container.runtime` can
select gVisor (`runsc`) or Kata for a stronger boundary. It is never chosen silently when a microVM provider is
ready.

### 3.10 What the user and the agent see

- **New thread:** the host chip lists, under each sandbox-capable host, a **Sandbox** destination, and it is
  the default (setting `isolation.default`, values `sandbox` or `workspace`, default `sandbox`). The user can
  switch one thread, or the default, back to a plain workspace.
- **When no provider is ready** on the chosen host, the thread is not silently run unisolated. The setting
  `isolation.whenUnavailable` decides: `ask` (default) shows why and offers "Run without sandbox", "Use a remote
  sandbox host" and the `sandbox_doctor` fix; `workspace` falls back with a visible badge; `refuse` blocks.
- **Sandboxes page** (under Hosts): one row per sandbox with host, state, thread, CPU, memory, disk, age and
  the actions Stop, Start, Export, Destroy, Logs.
- **Thread header:** a badge "Sandbox · `<host>`" and, when stopped, a Start control.
- **Agent tools** (parity rule): `sandbox_list`, `sandbox_inspect`, `sandbox_logs` (read-only);
  `sandbox_create`, `sandbox_start`, `sandbox_stop`, `sandbox_export` (write, "only when the user asked");
  `sandbox_destroy` with a mandatory explicit `confirmDestroy` argument and no default.
- **Readiness:** `sandbox_doctor` reports why a host cannot run sandboxes (no hypervisor, virtualization
  disabled, no container engine, disk too small) and the exact fix for each.

### 3.11 Starting in under 2 seconds

microsandbox reports guest boots under 100 ms, but a DSH runtime measured about 8 s of CPU to boot with the
full web composition. Three levers, the first two provider-neutral:

1. **A minimal `sandbox` profile.** S1 measures its cold start. If it already fits in 2 s, nothing more is
   needed.
2. **A warm pool.** Each host keeps a small number of sandboxes already started and idle (default 1). "Create"
   hands one over, loads the project into it, and the pool refills in the background. Works with every
   provider, containers included. Cost: one idle runtime's memory per spare.
3. **A golden snapshot,** where the provider has the capability (microsandbox, Firecracker): restore a saved,
   already-started guest instead of starting one, then give it a new identity and random seed.

A provider that cannot meet the budget declares a slower start, which the UI shows.

## 4. Phases

Each phase ends with an exit gate. A phase does not start before the previous gate is met.

### P0. Feasibility spikes and decisions

Throwaway scripts in a scratch directory, run on the user's local machines. No plugin code.

| Spike | Question | Done when |
| ----- | -------- | --------- |
| S1 | Does a stock DSH runtime start in a microsandbox guest with a minimal profile, and how fast? | on Linux, a guest answers an authenticated RPC through its endpoint; create-to-ready time and settled RSS recorded against the 2 s budget |
| S2 | Does multi-host mirror a Session of that guest through a plain loopback forward? | a thread created from a scratch control Host runs one fake-model turn in the guest |
| S3 | Do file tools, MCP servers and the agent loop run in the Host process? | read from the installed core, with file and line; confirms or kills the exec-only fallback argument |
| S4 | Can a guest provider use a custom base URL, so the model proxy works? | one model call from the guest goes through a host proxy that adds the key |
| S5 | Does microsandbox run inside Docker with only `/dev/kvm`? | one microVM starts in a container without `--privileged`; the exact flags are written down |
| S6 | Snapshot restore: time, and is the runtime usable after an identity and entropy reset? | restore-to-ready time recorded; two clones show different identities and random output |
| S7 | Deny-by-default networking: do `git`, `pnpm install` and a model call work through the allowlist? | all three succeed; a non-allowlisted host is refused and logged |
| S8 | Does microsandbox run natively on Windows, as its README says? | S1 repeats on Windows without WSL2; if it needs WSL2, that is recorded and the Windows path becomes "inside WSL2" |
| S9 | Does microsandbox run on the user's Mac? | S1 repeats on macOS; the minimum macOS version and chip are recorded |
| S10 | Is the read-only mount enforced on the host side? | a root process in the guest cannot write through a read-only mount, on each system |
| S11 | Does the hardened container start the same image? | the P1 journey's guest starts under Docker and Podman with the flags of section 3.9 |

**Decisions to take with the user at the end of P0:** guest runtime vs exec-only (S1–S3); model proxy vs
injected key (S4); in-container sandboxes vs T3-only for Docker (S5); which start levers are needed (S1, S6);
microsandbox confirmed as first provider, or replaced (S1, S8, S9); the guest image base.

**Exit gate:** a written `P0-findings.md` in this folder with every spike's command, numbers and verdict, the
decisions, and section 6's budgets confirmed or revised.

### P1. Port, orchestrator and fake provider (no KVM needed)

1. `@dshfiles/sandbox-provider-port`: schemas, capability flags, typed errors, contract tests any provider must pass.
2. `@dshfiles/sandbox-fake`: runs the guest runtime as a local process in a scratch home, with a loopback endpoint.
3. `@dshfiles/sandboxes` Host half: records, state machine, reconciliation, quotas, retention, the loopback forward.
4. multi-host: the `runtime-source` registry module; ephemeral runtimes appear and disappear without touching `directory.json`.
5. Host API and the agent tools of section 3.10, bound to the dshx methods.

**Exit gate:** on a machine without KVM, an e2e journey creates a sandbox thread with the fake provider, runs
one fake-model turn, stops, restarts and destroys it; killing the Host mid-`booting` leaves no orphan process
after restart; the port's contract tests pass against the fake provider.

### P2. Project in, changes back out, credentials, egress

Built and tested against the fake provider, so it is done before any hypervisor work.

1. `copy` mode end to end: bundle in, guest agent commit and push after each turn, host fetch into
   `sandbox/<thread>`, thread workspace refresh, Land.
2. Explicit file selection in; bounded `sandbox_export` out.
3. `mount-readonly` and `mount` as per-project opt-ins, with their badges.
4. Egress allowlist with denial log; model proxy with per-sandbox tokens.

**Exit gate:** an agent in a sandbox edits tracked and untracked files without committing; after the turn the
files are in the thread workspace on the host and the user's own checkout is byte-identical to before; the
work lands; tests W1–W4 and I7–I9 pass with the fake provider.

### P3. Container fallback provider

`@dshfiles/sandbox-container`: Docker and Podman detection, the hardening flags of section 3.9, the internal
network and proxy, the optional `container.runtime`, readiness reasons.

**Exit gate:** the port's contract tests and the P1 and P2 gates pass with the container provider; the isolation
tests that apply to containers (I1–I5, I7–I9) pass; the UI and `sandbox_inspect` report "container, weaker".

### P4. microsandbox provider on Linux, macOS and Windows

1. `@dshfiles/sandbox-microsandbox` through the TypeScript SDK, at a pinned version: readiness, image pull,
   create, start, endpoint, limits, logs, stop, destroy, snapshot and restore.
2. The start levers chosen in P0 (section 3.11).
3. Readiness reasons per system: KVM missing, Windows Hypervisor Platform disabled, Intel Mac.

**Exit gate:** on each of the three systems, a committed report shows the port's contract tests, the P1 and P2
gates and tests I1–I9 passing, and create → first prompt accepted at most 2 s at p95 over 50 creates.

### P5. Harness in Docker (T2)

The compose file, the image for the harness itself, documentation of the exact flags from S5.

**Exit gate:** the P4 gate passes with the control Host running in a container on Linux.

### P6. Remote machine (T3)

1. Allowlist the `sandboxes` lifecycle calls in multi-host's remote plugin calls.
2. SSH: second forward to the guest endpoint. Pairing link: the scoped relay.
3. Auto placement counts a host's free sandbox quota. The bare repository of section 3.5 lives on the sandbox
   host; the control Host fetches from it through the same connection.

**Exit gate:** from a control Host on another machine, create, use, stop and destroy a sandbox on a remote
host over SSH and over a pairing link; the changes arrive in a thread workspace on the control machine;
cutting the connection mid-turn loses no work and the thread resumes; the relay refuses a non-sandbox target.
The relay and allowlist logic is also covered here with the fake provider.

### P7. UI, tools, telemetry, docs

The Sandboxes page (reachable from the command palette and the New tab chooser), chip entries, thread badges,
`sandbox_doctor`, the settings of sections 3.5, 3.8 and 3.10; screenshots; the feature catalog with a span per
lifecycle transition and an `onboarding` block; a pack entry; README per package; `docs/sandboxes.md`;
`complete-plan` on the finished parts.

**Exit gate:** `check:screenshots`, `features:check`, the plugin boot check and one browser journey per
package pass; the page works at 390 px width with 44 px targets and keyboard only.

### P8. Density

1. Warm pool sizing from measured demand, bounded by quota.
2. Pause on idle, resume on prompt.

**Exit gate:** the density rows of section 6 are met and recorded in `docs/performance.md` with before and
after.

### P9. Firecracker provider

For Linux hosts that run many sandboxes: jailer, API socket, vsock endpoint, snapshots, a root filesystem
converted from the OCI image. It has no shared folders, so it supports `copy` mode only.

**Exit gate:** the port's contract tests, the P1 and P2 gates and tests I1–I9 pass with no change outside the new
package and the image build.

## 5. How we know it works: acceptance tests

Automated, in `plugins/@dshfiles/sandboxes/tests/acceptance/`. Each runs two sandboxes, A and B, on one host
unless stated. A test passes only on the stated observation. Every test runs against every microVM provider.

| Id | Claim | Probe | Pass when |
| --- | --- | --- | --- |
| I1 | A cannot read B's files | A scans every block device and mount it can see for a marker written in B | marker not found |
| I2 | A cannot read the host's files | A looks for a marker in the host user's home and in the DSH home | not found; no host path is mounted |
| I3 | A cannot see other processes | A lists processes | only guest processes; no host or B pid |
| I4 | A cannot reach the host's DSH | A connects to the host's loopback and LAN addresses on the DSH port | no route (no NIC) and the proxy refuses |
| I5 | A cannot reach B | A tries B's vsock CID and any address | refused |
| I6 | Limits hold | fork bomb, memory hog and disk fill in A | A degrades or is OOM-killed inside the guest; B's turn latency and the host's `host-lag` stay within 20 % of baseline |
| I7 | Egress is allowlisted | A fetches an allowed and a non-allowed host | first succeeds, second is refused and logged with the sandbox id |
| I8 | No real key in the guest | scan A's memory dump and drives for the real model key | absent; the per-sandbox token is present |
| I9 | Revocation works | destroy A, replay its token against the model proxy | refused |
| L1 | Crash recovery | `kill -9` the control Host while A is `ready` and B is `booting` | after restart A is reattached and usable, B is cleaned or resumed, no orphan `firecracker` process, no leaked drive file |
| L2 | No leak over time | create and destroy 200 sandboxes | process count, open files, disk use and Host RSS return to baseline ±5 % |
| L3 | Destroy is guarded | call `sandbox_destroy` without `confirmDestroy` on a sandbox with unlanded commits | refused with the commit count and how to land or export |
| C1 | Parallelism | 8 sandboxes on one host, each running a 20-step fake-model turn at once | all 8 finish; no cross-talk in transcripts; host `host-lag` p99 under 250 ms |
| C2 | Topologies | the phase P1 journey in topologies T1, T2 and T3 | passes in all three |
| C3 | Provider neutrality | the port's contract suite against fake, container, microsandbox and Firecracker | same suite, all pass |
| C4 | Operating systems | the P4 gate on Linux, Windows and macOS | passes on all three |
| W1 | Changes come back | the agent edits a tracked file and creates an untracked one, without committing | after the turn both are in the thread workspace on the host |
| W2 | The user's checkout is untouched | hash the user's checkout and `.git` configuration and hooks before and after a sandbox session | identical |
| W3 | Nothing executable crosses | the agent writes a git hook, a `.gitmodules` entry and a filter attribute in the sandbox | no hook is installed on the host, no submodule is fetched, no filter runs |
| W4 | Mount modes are honest | `mount-readonly`: a root process in the guest writes to the mount; `copy`: the guest looks for any host path | the write fails on every provider that offers the mode; no host path exists in `copy` |
| C5 | Start time | 50 creates in a row, timing create → first prompt accepted | p95 at most 2 s on each platform |
| D1 | Sandbox is the default | create a thread with default settings on a ready host, and on a host with no provider | first runs in a sandbox; second asks, and never runs unisolated without the user's choice |
| D2 | Retention is configurable | set `retention.stoppedHours` to 1 on a host and 0 on one sandbox | drives destroyed after 1 h and at stop respectively; the default host keeps them 24 h |

Negative tests on the control plane: a wrong runtime identity behind an endpoint is refused; the scoped relay
refuses a non-sandbox target; a sandbox on host X cannot be controlled with host Y's link credential.

### 5.1 Who runs what

| Where | What runs | How |
| --- | --- | --- |
| Here (cloud session, CI) | unit tests, the port's contract suite, the P1 and P2 gates against the fake provider, W1–W3, L1–L3, D1, D2, the relay and allowlist tests, UI journeys; the container provider too if the Docker daemon runs | the repository's normal checks |
| The user's Linux machine | S1–S7, S10, S11, then the full suite with microsandbox, the Docker gate, later Firecracker | `node scripts/sandbox-acceptance.mjs --provider microsandbox` |
| The user's Mac | S9, S10, then the full suite | the same command |
| The user's Windows machine | S8, S10, then the full suite | the same command |

`sandbox-acceptance.mjs` first runs `sandbox_doctor`, then the suite, and writes
`plans/microvm-sandboxes/reports/<date>-<os>-<provider>.md`: machine facts, each test's observation and
verdict, and the timings. A phase gate that needs a local machine is met only by a committed report. No secret
and no personal path goes into a report; the script redacts the home directory and host name.

## 6. Budgets

Measured with the existing probes, recorded in `docs/performance.md`. Revised once after P0.

| Measure | Target | Phase that must meet it |
| --- | --- | --- |
| Create → first prompt accepted, p95 | ≤ 2 s on Linux, Windows and macOS | P4 |
| Changes visible in the host thread workspace after a turn ends | ≤ 3 s for a 50-file change | P2 |
| Guest runtime settled RSS | ≤ 300 MB | P4 |
| Host overhead per idle sandbox (outside guest memory) | ≤ 30 MB | P4 |
| Idle sandbox CPU on the host | ≤ 0.5 % of a core; paused: 0 % | P4; P8 |
| Disk per sandbox before work | ≤ 50 MB (writable layer) | P4 |
| Sandboxes on a 16 GB / 8-core host | 8 active; + 16 paused | P4; P8 |

## 7. Risks

| Risk | Effect | Mitigation |
| --- | --- | --- |
| microsandbox is beta and changes under us | breakage on update | pinned version, the port's contract suite on every bump, the container provider as a working alternative |
| Its Windows or macOS support is not what the README says | a system without a microVM | S8 and S9 first; fallbacks in order: WSL2, QEMU as a provider, the labelled container |
| Guest runtime too heavy | density and the 2 s start miss the budgets | minimal profile, warm pool, golden snapshot (section 3.11), measured in P0; exec-only fallback decided at P0 |
| Git sync misses something the user expects (ignored files, large binaries) | "my changes are not there" | the working tree commit includes untracked files; `sandbox_export` for the rest; `mount-readonly` for projects that need the live tree |
| A user turns on `mount` without seeing the consequence | host code execution through the project | off by default, per project, a permanent badge, and the explanation of section 3.5 in the setting |
| Container fallback mistaken for a microVM | false sense of security | the `isolation` capability is shown on the thread, the page and in `sandbox_inspect`; never chosen silently |
| Snapshot clones share secrets or randomness | cross-sandbox leak | the guest agent re-identifies and reseeds after restore; S6 checks it; no secret is in a snapshot by construction |
| Model proxy unsupported by a provider | key must enter the guest | fallback key, spend-capped and short-lived, flagged in the UI |
| Sandbox by default surprises a user whose machine cannot run one | threads blocked | `isolation.whenUnavailable` asks with three ways forward; never a silent unisolated run |
| multi-host changes underneath | rework | only two seams are touched: the `runtime-source` registry and the remote-call allowlist |
| Hypervisor or kernel CVE | guest escape | pinned versions with checksums, an update policy in each provider README, never run as root |

## 8. Decisions taken (2026-11-14)

| Topic | Decision |
| --- | --- |
| Operating systems | Linux, macOS and Windows |
| Technology | one microVM runtime for the three systems first (microsandbox), containers as the labelled fallback, Firecracker afterwards |
| Project files | copied in and synchronised back through git by default; mounting the folder is possible but opt-in, because maximum security is the priority |
| Start time | at most 2 s from create to first prompt accepted |
| Testing | everything except the hypervisor here; hypervisor parts on the user's local machines, by committed report |
| Network | no interface, proxy only, as the default; a real NIC is a later option |
| Default | a new thread runs in a sandbox by default |
| macOS | a local microVM is a priority; a container is acceptable only as a labelled fallback |
| Retention | 24 h by default, configurable per host and per sandbox |

## 9. Still open

1. The local test machines: Linux distribution and CPU architecture, macOS version and chip, Windows version.
   They set the image architectures to build first and the minimum versions we state.
2. When no provider is ready, is `ask` the right default for `isolation.whenUnavailable`, or should it be
   `refuse`?
