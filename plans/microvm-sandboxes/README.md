# Sandboxes: isolated parallel agents on any host

Run each agent thread in its own sandbox, on this machine or on a remote one, from a harness that runs on Linux,
macOS or Windows, directly or in Docker. Two providers are offered side by side:

- **microsandbox**, a microVM runtime built on libkrun that runs natively on the three systems;
- **containers**, through Docker or Podman, hardened.

Both are built, both are evaluated with the same tests, and the user chooses per host. Firecracker can be added
later behind the same port, for dense Linux servers.

**Status:** plan only. Nothing is built. Statements marked _(verify in P0)_ are assumptions that the first phase
must confirm or replace before any later phase starts.

**Resume here:** Phase 0. Spike S3 is done and reopens the central choice of section 3.1: see
[P0 findings](P0-findings.md). Next: run S2 and S12 here, then decide between architectures A and B with the
user. Nothing in P1 starts before that decision.

| Phase | Deliverable                                                  | Where it is tested                    | State       |
| ----- | ------------------------------------------------------------ | ------------------------------------- | ----------- |
| P0    | Feasibility spikes and decisions                             | here where possible; Fedora for KVM   | not started |
| P1    | Provider port, orchestrator, fake provider                   | here                                  | not started |
| P2    | Project in, changes back out (git sync), credentials, egress | here, with the fake provider          | not started |
| P3    | Container provider (Docker, Podman)                          | here (Docker); Podman on Fedora       | not started |
| P4    | microsandbox provider on Linux, macOS and Windows            | local machines                        | not started |
| P5    | Evaluation of the two providers, and the default             | local machines                        | not started |
| P6    | Harness in Docker                                            | local Linux machine                   | not started |
| P7    | Sandboxes on a remote machine                                | here with fake; local for the rest    | not started |
| P8    | UI, agent tools, telemetry, docs                             | here                                  | not started |
| P9    | Density: warm pool sizing, pause on idle                     | local machines                        | not started |
| P10   | Optional: Firecracker provider for Linux hosts               | local Linux machine                   | not started |

## 1. What we want

1. **Isolation.** Several agents work at once on one machine. No agent can read or change another agent's files,
   processes, network traffic or credentials, nor the machine's own.
2. **Three topologies, one behaviour.**
   - **T1 bare host:** the harness runs directly on the machine and starts sandboxes there.
   - **T2 Docker:** the harness runs in a container and still starts and reaches sandboxes.
   - **T3 remote:** the harness runs anywhere and the sandboxes run on another machine.
3. **Three operating systems.** Linux, macOS and Windows.
4. **Two providers, the user's choice.** A microVM (microsandbox) and a container (Docker or Podman), each
   labelled with the isolation it really gives.
5. **Fast.** At most 2 s from "create" to the first prompt accepted.
6. **Sandbox by default.** A new thread runs in a sandbox unless the user chooses otherwise.
7. **The project goes in, the changes come back.** The agent works on the user's project inside the sandbox,
   and the user finds the modifications on their own machine, without giving the sandbox a way to write to
   the host.
8. **It composes with multi-host.** One harness reaches several machines; each machine can run several sandboxes.
9. **Provider-neutral.** Adding a provider means writing one package, not touching the orchestrator, the UI or
   multi-host.
10. **Stock DSH.** No core patch, as everywhere in this repository.

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
  ([performance](../../docs/performance.md)). Both numbers matter for start time and density.

About the two providers (read from each project's own pages on 2026-11-14; _all to verify in P0_):

| | microsandbox | Docker or Podman containers |
| --- | --- | --- |
| Boundary | a hardware-virtualized microVM with its own kernel | namespaces and cgroups on a kernel shared by all sandboxes |
| Linux | yes, needs KVM | yes |
| macOS | Apple silicon only | yes, inside the engine's own Linux VM |
| Windows | yes, natively through Windows Hypervisor Platform (one third-party review says WSL2 is needed) | yes, inside WSL2 or the engine's VM |
| Works where no hypervisor is available (Intel Mac, a VM without nested virtualization, a container) | no | yes |
| Runs | embedded library and CLI, no daemon, TypeScript SDK | a daemon (Docker) or daemonless (Podman), driven by CLI |
| Images | standard OCI images | standard OCI images |
| Start | guest boot reported under 100 ms | typically a few hundred milliseconds |
| Snapshot of a running sandbox | yes (save, restore, fork) | not relied on (checkpointing is experimental and Linux-only) |
| Network control | built-in egress allowlist | an internal network plus our proxy |
| Secrets | advertised as never entering the VM | our model proxy |
| Host folder mounts | virtio-fs, read-only enforced on the host side | bind mounts, read-only enforced by the kernel the sandbox shares |
| Maturity | calls itself beta, breaking changes expected; Apache-2.0 | mature |

Why not the others: QEMU runs everywhere but is large, slower to start and has the biggest attack surface;
Firecracker has no macOS support and reaches Windows only through WSL2; Apple Virtualization is macOS only;
Kata Containers and gVisor are Linux only (they remain usable as a container runtime, section 3.9).

Where things are tested:

- **Here (cloud session).** No `/dev/kvm`, so no microVM. Docker 29 does run here (started by hand, rootful,
  cgroup v1), and a hardened container starts (`--cap-drop ALL`, `no-new-privileges`, read-only root, no
  network, non-root user; checked 2026-11-14). So the orchestrator, the git sync and the **container provider
  with Docker** are built and tested here. As much as possible is done here.
- **The user's machine:** Fedora 44, AMD Ryzen (x86_64), 16 GB of RAM. It runs the final tests: microsandbox
  (needs KVM), Podman, rootless engines, and the budgets. It is the reference machine for section 6.
- macOS and Windows are tested when such a machine is available; until then their rows stay "not verified".

## 3. Design

### 3.1 The central choice: a sandbox is a guest runtime

Each sandbox starts a **stock DSH runtime** with a small profile. The control Host treats it as one more
multi-host runtime and mirrors its Sessions, exactly as it does for a remote machine today.

Why this and not "run only the shell commands in the sandbox":

| Approach                                | What stays outside the sandbox                           | Verdict                                                                   |
| --------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------- |
| **Guest runtime** (chosen)              | nothing of the agent: loop, file tools, shell, jobs, MCP | full isolation; reuses the remote-thread path that already works          |
| Exec-only (swap the subprocess service) | the agent loop, file tools and MCP servers, in the Host  | a file tool or MCP server still reads the host; needs forks of every tool |

**Under review (2026-11-14).** S3 showed the verdict on exec-only above is wrong: DSH core documents replacing
`ctx.fs`, `ctx.subprocess` and `ctx.sandbox` as the route for containers and microVMs, and the core file and
shell tools already go through those seams. [P0 findings](P0-findings.md) compares the two architectures. The
rest of this plan (providers, git sync, network, tests, budgets) holds for both; sections 3.2, 3.4, 3.7 and 3.11
change if B is chosen.

Cost of the choice: each sandbox pays a runtime's RAM and start time. Section 3.11 covers the start time. If P0
shows the guest runtime cannot fit the budgets in section 6, exec-only becomes the fallback and this plan is
revised before P1.

### 3.2 Components

```
control Host (T1 bare, or T2 in Docker)                    sandbox host (same machine in T1/T2, remote in T3)
┌───────────────────────────────────────────┐              ┌──────────────────────────────────────────────┐
│ @dshfiles/sandboxes      orchestrator, UI │── dshx API ──│ @dshfiles/sandboxes   (same package, Host half)│
│ @dshfiles/multi-host     mirrors Sessions │              │ a provider: microsandbox or container         │
│                                           │              │   one microVM or container per sandbox        │
│                                           │── gateway ───│   endpoint ──► guest agent ──► guest runtime  │
└───────────────────────────────────────────┘              └──────────────────────────────────────────────┘
```

| Package                           | Role                                                                                              | Depends on                         |
| --------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `@dshfiles/sandbox-provider-port` | The contract a provider implements, as a dshx module. No behaviour.                               | dshx                               |
| `@dshfiles/sandboxes`             | Orchestrator: records, lifecycle, reconciliation, quotas, git sync, proxies, page, tools.         | the port, multi-host, sqlite-store |
| `@dshfiles/sandbox-microsandbox`  | microVM provider for Linux, macOS and Windows, through the microsandbox TypeScript SDK.           | the port                           |
| `@dshfiles/sandbox-container`     | Container provider: Docker or Podman, hardened; optional gVisor or Kata runtime on Linux.         | the port                           |
| `@dshfiles/sandbox-fake`          | Test provider: runs the guest runtime as a plain local process in a scratch home.                 | the port                           |
| `tooling/sandbox-image`           | Reproducible build of one OCI image (x86_64 and aarch64) with the guest runtime and guest agent.  | none at run time                   |

Dependencies point one way ([plugin boundaries](../../docs/plugin-boundaries.md)): providers know only the port;
`sandboxes` knows the port and multi-host; multi-host knows none of them. multi-host gains one registry module
(`@dshfiles/multi-host/runtime-source`) through which `sandboxes` contributes ephemeral runtimes and a
destination entry; multi-host renders nothing new when `sandboxes` is absent.

### 3.3 The provider port

One dshx contract, versioned, with capability flags so the orchestrator never guesses.

| Method                 | Input                                                  | Result                                                           |
| ---------------------- | ------------------------------------------------------ | ---------------------------------------------------------------- |
| `describe`             | none                                                   | provider id, version, capabilities, host readiness with reasons  |
| `prepareImage`         | image reference                                        | local image id, sizes, checksum                                  |
| `create`               | sandbox id, image id, vCPU, memory, disk size, mounts  | provider handle                                                  |
| `start`                | handle                                                 | a `SandboxEndpoint` (below)                                      |
| `stop`                 | handle, grace period                                   | exit state                                                       |
| `destroy`              | handle                                                 | freed bytes                                                      |
| `inspect`              | handle                                                 | state, CPU, memory, disk, uptime                                 |
| `list`                 | none                                                   | every instance the provider can see, recorded or not             |
| `logs`                 | handle, byte bound                                     | bounded console tail                                             |
| `snapshot` / `restore` | handle or snapshot id                                  | only when the capability is declared                             |

Capabilities: `isolation` (`microvm` or `container`), `snapshot`, `pause`, `readOnlyMount`, `writableMount`,
`egressAllowlist`, `secretInjection`, `architectures`. The UI shows `isolation` everywhere a sandbox appears, so
a container is never mistaken for a microVM.

`SandboxEndpoint` is the only thing the orchestrator needs to reach the guest: a host-side stream factory
(`open(port) → duplex`), implemented by both providers as a port published on the host's loopback only. The
orchestrator hands multi-host a normal local launch URL, so multi-host's existing `connectLocal` path is reused
unchanged _(verify in P0)_.

Everything in sections 3.4 to 3.8 is shared by all providers. A provider only starts the image and exposes the
endpoint.

Every failure is a typed error with a recovery sentence, for example: `no-hypervisor` → "This machine cannot
start a microVM (virtualization is off). Turn it on in the firmware, switch this host to the container
provider, or choose a remote sandbox host under Hosts."

### 3.4 Inside the guest

One **OCI image** serves both providers.

- **Contents:** minimal Linux userland, the Node version from `.node-version`, the pinned DSH core, the built
  dshfiles bundles the `sandbox` profile needs, git and jj, the guest agent. Built for x86_64 and aarch64.
- **Root filesystem:** read-only image layers shared by every sandbox, with a per-sandbox writable layer whose
  size is the sandbox's disk quota. Deleting the sandbox deletes the layer.
- **Guest agent:** a small static binary started first. It starts the DSH runtime bound to the guest's
  loopback, reports readiness, applies start parameters (runtime identity, launch token, proxy addresses),
  commits and pushes the work after each turn (section 3.5), gives a restored snapshot a new identity and
  random seed, and stops the guest cleanly on request.
- **Unprivileged inside:** the runtime and the agent's commands run as a non-root user in the guest, in both
  providers.
- **`sandbox` profile:** seeded like `profiles/web` but minimal: multi-host (to be mirrored), the VCS provider,
  the tools an agent needs. No Hosts page, no browser-only bundles. Target: under 300 MB RSS settled.

No secret, account file or host path is ever written into the image. `tooling/sandbox-image` fails its build if
a secret scanner finds one.

### 3.5 The project goes in, the changes come back

The setting `workspace.mode` chooses how, per project. The default is the safest.

| Mode                 | How the project gets in                                                       | How changes get back                       | What the sandbox can do to the host             |
| -------------------- | ----------------------------------------------------------------------------- | ------------------------------------------ | ----------------------------------------------- |
| **`copy`** (default) | a git bundle of the base revision, plus files the user picks                  | git: the host fetches the sandbox's commits | nothing: no host folder is visible              |
| `mount-readonly`     | the project folder mounted read-only, writes go to a layer inside the sandbox | git, as in `copy`                          | read every file in the folder, secrets included |
| `mount`              | the project folder mounted read-write                                         | already there                              | change any file in the folder at any time       |

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
that need the live tree). Each must be turned on per project and shows a badge on the thread. With the
container provider a mount is weaker than with a microVM, because the kernel that enforces it is shared with
the sandbox; the setting says so.

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
  per-sandbox token. The proxy validates the token, attaches the real credential resolved on the Host through
  the existing `secret:ALIAS` path, and forwards. Revoking a sandbox revokes its token. Requires that the
  guest's provider configuration accepts a custom base URL _(verify in P0)_.
- microsandbox advertises secrets that never enter the VM and are bound to one allowed host. If S4 shows that
  covers model calls, that provider uses it; the orchestrator's proxy serves the container provider either way.
- **Fallback:** a short-lived, spend-capped key injected into guest memory at start. Weaker: the agent can read
  it. Used only if the proxy route is impossible, and flagged in the UI.
- Forge credentials follow the same rule: pushes go to the per-sandbox bare repository on the host; the host,
  not the guest, pushes to the real remote when the user lands the work.

### 3.8 Lifecycle and records

Records live in a plugin-owned SQLite store (`sqlite-store`, deferred open, bounded WAL).

```
requested → preparing → starting → ready ⇄ paused → stopping → stopped → destroyed
                 └──────────┴────────┴──────────────► failed(reason, recovery)
```

- Every transition is one span and one row update; a crash between two steps is resumable from the row.
- **Reconciliation** at Host start and every minute: `provider.list()` against the records. An instance with no
  record is stopped and destroyed; a record with no instance becomes `failed(lost)`. This extends the existing
  [orphan cleanup](../../docs/orphan-cleanup.md).
- **Quotas per host:** maximum sandboxes, total vCPU, total memory, total disk. A request over quota is refused
  with the numbers and what to stop.
- **Retention:** a stopped sandbox keeps its writable layer so work can still be landed, then is destroyed. The
  delay is the setting `retention.stoppedHours`: default 24, set per host, overridable per sandbox
  (`sandbox_set_retention`), `0` meaning "destroy at stop". Destroying a sandbox with unlanded commits requires
  an explicit opt-in argument.
- **Identity:** each sandbox gets a fresh runtime identity and launch token at create, pinned in multi-host's
  directory like any runtime. A different runtime behind the same endpoint is refused.

### 3.9 Providers, topologies and operating systems

**Choosing the provider.** The setting `provider`, per host: `auto` (default), `microsandbox` or `container`.
`auto` uses the microVM when the host can run one. When it cannot, the user is asked once per host, with the
reason and the container offered; the answer is remembered. A sandbox never changes provider silently.

| Machine that hosts the sandboxes                       | microsandbox | container             |
| ------------------------------------------------------ | ------------ | --------------------- |
| Linux with KVM                                         | yes          | yes                   |
| Linux without KVM (a VM without nested virtualization) | no           | yes                   |
| macOS, Apple silicon                                   | yes          | yes, in the engine VM |
| macOS, Intel                                           | no           | yes, in the engine VM |
| Windows with Windows Hypervisor Platform               | yes          | yes, in WSL2          |

**The container provider's hardening:** rootless is recommended, not required: a rootful engine works and
shows a warning with how to switch (Podman is rootless by default; Docker has a rootless mode). Beyond that: all capabilities dropped, `no-new-privileges`, the default seccomp profile, a user namespace, a
read-only root with a size-limited writable layer, process, memory and CPU limits, no host socket and no device.
On Linux the setting `container.runtime` can select gVisor (`runsc`) or Kata for a stronger boundary. The engine
(`docker` or `podman`) is detected, and can be forced with `container.engine`.

**Topologies:**

| | Where the provider runs | How the control Host reaches the guest | Host requirements |
| --- | --- | --- | --- |
| **T1 bare** | same Host process | the provider's endpoint, on the host's loopback | a hypervisor for microsandbox, or Docker/Podman for containers |
| **T2 Docker** | inside the harness container | same as T1 | microsandbox: `--device /dev/kvm` and a volume, Linux host only. Containers: rootless Podman inside the container, or the host engine's socket, opt-in _(verify in P0)_ |
| **T3 remote** | on the remote machine's own DSH | multi-host connector to the remote Host, then that Host's forward to the guest | the remote machine meets T1; this machine needs nothing |

T2 notes: giving the harness container the host's Docker socket gives it control of the host, so that route is
off by default and labelled. The harness in Docker on macOS or Windows has no KVM inside; there it uses the
container route or T3.

T3 details:

- The remote machine runs DSH with `multi-host`, `sandboxes` and a provider. The control Host calls the remote
  `sandboxes` API through multi-host's allowlisted remote plugin calls; the allowlist gains exactly the
  `sandboxes` lifecycle methods.
- Reaching the guest: over SSH, one more `-L` to the per-sandbox forward on the remote loopback. Over a pairing
  link, the link gateway gains a **scoped relay** that forwards only to sandbox endpoints the remote
  orchestrator registered. Today's "no relay" limit stays true for everything else.
- The bare repository of section 3.5 lives on the sandbox host; the control Host fetches from it through the
  same connection.

### 3.10 What the user and the agent see

- **New thread:** the host chip lists, under each sandbox-capable host, a **Sandbox** destination, and it is
  the default (setting `isolation.default`, values `sandbox` or `workspace`, default `sandbox`). The user can
  switch one thread, or the default, back to a plain workspace.
- **When no provider is ready** on the chosen host, the thread runs as it does today, in a plain thread
  workspace, with a visible "Not sandboxed" badge that links to `sandbox_doctor`. The setting
  `isolation.whenUnavailable` can change that: `workspace` (default), `ask` or `refuse`.
- **Sandboxes page** (under Hosts): one row per sandbox with host, provider, isolation, state, thread, CPU,
  memory, disk, age and the actions Stop, Start, Export, Destroy, Logs.
- **Thread header:** a badge "Sandbox · microVM · `<host>`" or "Sandbox · container · `<host>`", the workspace
  mode when it is not `copy`, and a Start control when stopped.
- **Agent tools** (parity rule): `sandbox_list`, `sandbox_inspect`, `sandbox_logs` (read-only);
  `sandbox_create`, `sandbox_start`, `sandbox_stop`, `sandbox_export`, `sandbox_set_retention` (write, "only
  when the user asked"); `sandbox_destroy` with a mandatory explicit `confirmDestroy` argument and no default.
- **Readiness:** `sandbox_doctor` reports, per provider, why a host cannot run it (no hypervisor,
  virtualization disabled, Intel Mac, no container engine, engine not rootless, disk too small) and the exact
  fix for each.

### 3.11 Starting in under 2 seconds

Starting the sandbox is fast with both providers; starting a DSH runtime inside it is what costs (about 8 s of
CPU with the full web composition). Three levers, the first two provider-neutral:

1. **A minimal `sandbox` profile.** S1 measures its cold start. If it already fits in 2 s, nothing more is
   needed.
2. **A warm pool.** Each host keeps a small number of sandboxes already started and idle (default 1). "Create"
   hands one over, loads the project into it, and the pool refills in the background. Works with both
   providers. Cost: one idle runtime's memory per spare.
3. **A golden snapshot,** with microsandbox: restore a saved, already-started guest instead of starting one,
   then give it a new identity and random seed.

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
| S4 | Can a guest provider use a custom base URL, and does microsandbox's secret handling cover model calls? | one model call from the guest succeeds while the real key is absent from the guest |
| S5 | What does the harness in Docker need to start each kind of sandbox? | one microVM and one container start from inside a harness container without `--privileged`; the exact flags are written down |
| S6 | microsandbox snapshot restore: time, and is the runtime usable after an identity and entropy reset? | restore-to-ready time recorded; two clones show different identities and random output |
| S7 | Deny-by-default networking: do `git`, `pnpm install` and a model call work through the allowlist? | all three succeed with each provider; a non-allowlisted host is refused and logged |
| S8 | Does microsandbox run natively on Windows, as its README says? | S1 repeats on Windows without WSL2; if it needs WSL2, that is recorded and the Windows path becomes "inside WSL2" |
| S9 | Does microsandbox run on the user's Mac? | S1 repeats on macOS; the minimum macOS version and chip are recorded |
| S10 | Is the read-only mount enforced? | a root process in the guest cannot write through a read-only mount, with each provider, on each system |
| S11 | Does the hardened container start the same image, with Docker and with Podman? | S1 and S2 repeat with each engine and the flags of section 3.9; rootless status recorded |
| S12 | Architecture B: can one `ctx.fs` + `ctx.subprocess` provider route each Session's calls to its own sandbox? | here, with Docker: two threads each edit a file and run a command in their own container, with no cross-talk; terminals and background jobs checked |

**Decisions to take with the user at the end of P0:** guest runtime vs exec-only (S1–S3); model proxy vs
injected key (S4); the Docker route for each provider (S5); which start levers are needed (S1, S6); whether
microsandbox holds on the three systems (S1, S8, S9); the guest image base.

**Exit gate:** a written `P0-findings.md` in this folder with every spike's command, numbers and verdict, the
decisions, and section 6's budgets confirmed or revised.

### P1. Port, orchestrator and fake provider

1. `@dshfiles/sandbox-provider-port`: schemas, capability flags, typed errors, contract tests any provider must pass.
2. `@dshfiles/sandbox-fake`: runs the guest runtime as a local process in a scratch home, with a loopback endpoint.
3. `@dshfiles/sandboxes` Host half: records, state machine, reconciliation, quotas, retention, provider choice, the loopback forward.
4. multi-host: the `runtime-source` registry module; ephemeral runtimes appear and disappear without touching `directory.json`.
5. Host API and the agent tools of section 3.10, bound to the dshx methods.

**Exit gate:** here, an e2e journey creates a sandbox thread with the fake provider, runs one fake-model turn,
stops, restarts and destroys it; killing the Host mid-`starting` leaves no orphan process after restart; the
port's contract tests pass against the fake provider.

### P2. Project in, changes back out, credentials, egress

Built and tested against the fake provider, so it is done before any real provider.

1. `copy` mode end to end: bundle in, guest agent commit and push after each turn, host fetch into
   `sandbox/<thread>`, thread workspace refresh, Land.
2. Explicit file selection in; bounded `sandbox_export` out.
3. `mount-readonly` and `mount` as per-project opt-ins, with their badges.
4. Egress proxy with allowlist and denial log; model proxy with per-sandbox tokens.

**Exit gate:** an agent in a sandbox edits tracked and untracked files without committing; after the turn the
files are in the thread workspace on the host and the user's own checkout is byte-identical to before; the
work lands; tests W1–W3 and I7–I9 pass with the fake provider.

### P3. Container provider

`@dshfiles/sandbox-container`: Docker and Podman detection, the hardening of section 3.9, the internal network
and proxy, the optional `container.runtime`, readiness reasons.

**Exit gate:** with Docker and with Podman, the port's contract tests and the P1 and P2 gates pass; the
isolation tests pass or are recorded as "not provided by containers" with the reason (section 5); the UI and
`sandbox_inspect` report "container".

### P4. microsandbox provider on Linux, macOS and Windows

1. `@dshfiles/sandbox-microsandbox` through the TypeScript SDK, at a pinned version: readiness, image pull,
   create, start, endpoint, limits, logs, stop, destroy, snapshot and restore.
2. The start levers chosen in P0 (section 3.11).
3. Readiness reasons per system: KVM missing, Windows Hypervisor Platform disabled, Intel Mac.

**Exit gate:** on each of the three systems, a committed report shows the port's contract tests, the P1 and P2
gates and tests I1–I9 passing.

### P5. Evaluation of the two providers

Run the whole acceptance suite and the budgets with both providers on each system, and write
`plans/microvm-sandboxes/evaluation.md` with the matrix of section 5.2 filled in.

**Decisions to take with the user:** which provider `auto` prefers on each system; whether any combination is
withdrawn (for example containers without rootless); the default warm pool size per provider.

**Exit gate:** the matrix is complete, from committed reports, and the defaults are recorded in section 8.

### P6. Harness in Docker (T2)

The compose files, the image for the harness itself, documentation of the exact flags from S5 for each provider.

**Exit gate:** the P3 and P4 gates pass with the control Host running in a container on Linux.

### P7. Remote machine (T3)

1. Allowlist the `sandboxes` lifecycle calls in multi-host's remote plugin calls.
2. SSH: second forward to the guest endpoint. Pairing link: the scoped relay.
3. Auto placement counts a host's free sandbox quota.

**Exit gate:** from a control Host on another machine, create, use, stop and destroy a sandbox on a remote
host over SSH and over a pairing link, with each provider; the changes arrive in a thread workspace on the
control machine; cutting the connection mid-turn loses no work and the thread resumes; the relay refuses a
non-sandbox target. The relay and allowlist logic is also covered here with the fake provider.

### P8. UI, tools, telemetry, docs

The Sandboxes page (reachable from the command palette and the New tab chooser), chip entries, thread badges,
`sandbox_doctor`, the settings of sections 3.5, 3.8, 3.9 and 3.10; screenshots; the feature catalog with a span
per lifecycle transition and an `onboarding` block; a pack entry; README per package; `docs/sandboxes.md`;
`complete-plan` on the finished parts.

**Exit gate:** `check:screenshots`, `features:check`, the plugin boot check and one browser journey per
package pass; the page works at 390 px width with 44 px targets and keyboard only.

### P9. Density

1. Warm pool sizing from measured demand, bounded by quota.
2. Pause on idle, resume on prompt, where the provider can.

**Exit gate:** the density rows of section 6 are met and recorded in `docs/performance.md` with before and
after.

### P10. Optional: Firecracker provider

For Linux hosts that run many sandboxes: jailer, API socket, vsock endpoint, snapshots, a root filesystem
converted from the OCI image. It has no shared folders, so it supports `copy` mode only. Started only if P5 or
P9 shows a need.

**Exit gate:** the port's contract tests, the P1 and P2 gates and tests I1–I9 pass with no change outside the new
package and the image build.

## 5. How we know it works: acceptance tests

Automated, in `plugins/@dshfiles/sandboxes/tests/acceptance/`. Each runs two sandboxes, A and B, on one host
unless stated. A test passes only on the stated observation. Every test runs against both providers; the last
column says what is expected of containers, so a weaker result is recorded, never hidden.

| Id | Claim | Probe | Pass when | Containers |
| --- | --- | --- | --- | --- |
| I1 | A cannot read B's files | A scans every device and mount it can see for a marker written in B | marker not found | must pass |
| I2 | A cannot read the host's files | A looks for a marker in the host user's home and in the DSH home | not found; no host path is mounted | must pass |
| I3 | A cannot see other processes | A lists processes | only its own; no host or B pid | must pass |
| I4 | A cannot reach the host's DSH | A connects to the host's loopback and LAN addresses on the DSH port | refused | must pass |
| I5 | A cannot reach B | A tries B's addresses and endpoint | refused | must pass |
| I6 | Limits hold | fork bomb, memory hog and disk fill in A | A is contained; B's turn latency and the host's `host-lag` stay within 20 % of baseline | must pass |
| I7 | Egress is allowlisted | A fetches an allowed and a non-allowed host | first succeeds, second is refused and logged with the sandbox id | must pass |
| I8 | No real key in the guest | scan A's memory and disk for the real model key | absent; the per-sandbox token is present | must pass |
| I9 | Revocation works | destroy A, replay its token against the model proxy | refused | must pass |
| K1 | Own kernel | compare the kernel identity seen in A, in B and on the host | A and B each have their own | expected to fail: recorded as "shared kernel" |
| K2 | Root in the guest stays in the guest | a root process in A tries known namespace and device escapes | none succeeds | must pass; a rootful engine is also reported with a warning |
| W1 | Changes come back | the agent edits a tracked file and creates an untracked one, without committing | after the turn both are in the thread workspace on the host | must pass |
| W2 | The user's checkout is untouched | hash the user's checkout and `.git` configuration and hooks before and after a session | identical | must pass |
| W3 | Nothing executable crosses | the agent writes a git hook, a `.gitmodules` entry and a filter attribute in the sandbox | no hook is installed on the host, no submodule is fetched, no filter runs | must pass |
| W4 | Mount modes are honest | `mount-readonly`: a root process in the guest writes to the mount; `copy`: the guest looks for any host path | the write fails; no host path exists in `copy` | must pass |
| L1 | Crash recovery | `kill -9` the control Host while A is `ready` and B is `starting` | after restart A is reattached and usable, B is cleaned or resumed, no orphan instance, no leaked layer | must pass |
| L2 | No leak over time | create and destroy 200 sandboxes | process count, open files, disk use and Host RSS return to baseline ±5 % | must pass |
| L3 | Destroy is guarded | call `sandbox_destroy` without `confirmDestroy` on a sandbox with unlanded commits | refused with the commit count and how to land or export | must pass |
| C1 | Parallelism | 8 sandboxes on one host, each running a 20-step fake-model turn at once | all 8 finish; no cross-talk in transcripts; host `host-lag` p99 under 250 ms | must pass |
| C2 | Topologies | the phase P1 journey in topologies T1, T2 and T3 | passes in all three | must pass |
| C3 | Provider neutrality | the port's contract suite against fake, container and microsandbox | same suite, all pass | must pass |
| C4 | Operating systems | the provider's gate on Linux, Windows and macOS | passes on all three | must pass |
| C5 | Start time | 50 creates in a row, timing create → first prompt accepted | p95 at most 2 s | must pass |
| D1 | Sandbox is the default | create a thread with default settings on a ready host, and on a host with no provider | first runs in a sandbox; second runs in a plain workspace with the "Not sandboxed" badge | must pass |
| D2 | Retention is configurable | set `retention.stoppedHours` to 1 on a host and 0 on one sandbox | destroyed after 1 h and at stop respectively; the default host keeps them 24 h | must pass |
| D3 | The provider never changes silently | make the microVM provider unavailable on a host set to `auto` | the user is asked before a container is used; the thread badge names the provider | must pass |

Negative tests on the control plane: a wrong runtime identity behind an endpoint is refused; the scoped relay
refuses a non-sandbox target; a sandbox on host X cannot be controlled with host Y's link credential.

### 5.1 Who runs what

| Where | What runs | How |
| --- | --- | --- |
| Here (cloud session, CI) | unit tests, the port's contract suite, the P1 and P2 gates against the fake provider, W1–W3, L1–L3, D1–D3, the relay and allowlist tests, UI journeys | the repository's normal checks |
| The user's Linux machine | the spikes, then the full suite with each provider, and the Docker gate | `node scripts/sandbox-acceptance.mjs --provider microsandbox` and `--provider container --engine docker` or `podman` |
| The user's Mac | S9, S10, then the full suite with each provider | the same commands |
| The user's Windows machine | S8, S10, then the full suite with each provider | the same commands |

`sandbox-acceptance.mjs` first runs `sandbox_doctor`, then the suite, and writes
`plans/microvm-sandboxes/reports/<date>-<os>-<provider>.md`: machine facts, each test's observation and
verdict, and the timings. A phase gate that needs a local machine is met only by a committed report. No secret
and no personal path goes into a report; the script redacts the home directory and host name.

### 5.2 The evaluation matrix (filled in P5)

One column per provider and engine (microsandbox, Docker, Podman), one block per operating system.

| Criterion | Measured by |
| --- | --- |
| Isolation tests passed, and which are "not provided" | I1–I9, K1, K2, W4 |
| Create → first prompt accepted, p50 and p95, cold and with the warm pool | C5 |
| Memory per idle sandbox, guest and host overhead | section 6 probes |
| Sandboxes that run at once on the reference machine | C1, raised until `host-lag` breaks the budget |
| Disk per sandbox, and image size | section 6 probes |
| Time for a 50-file change to reach the host thread workspace | W1 timing |
| Setup: what the user must install or enable, and how long `sandbox_doctor` to green takes | recorded by hand |
| Systems and machines where it does not run | C4 and the readiness reasons |
| Stability: failures over the 200 create/destroy cycles | L2 |

## 6. Budgets

Measured with the existing probes, recorded in `docs/performance.md`. Revised once after P0. They apply to each
provider; P5 records where one misses.

| Measure | Target | Phase that must meet it |
| --- | --- | --- |
| Create → first prompt accepted, p95 | ≤ 2 s on Linux, Windows and macOS | P3, P4 |
| Changes visible in the host thread workspace after a turn ends | ≤ 3 s for a 50-file change | P2 |
| Guest runtime settled RSS | ≤ 300 MB | P3, P4 |
| Host overhead per idle sandbox (outside guest memory) | ≤ 30 MB | P3, P4 |
| Idle sandbox CPU on the host | ≤ 0.5 % of a core; paused: 0 % | P3, P4; P9 |
| Disk per sandbox before work | ≤ 50 MB (writable layer) | P3, P4 |
| Sandboxes on a 16 GB / 8-core host | 8 active; + 16 paused | P4; P9 |

## 7. Risks

| Risk | Effect | Mitigation |
| --- | --- | --- |
| microsandbox is beta and changes under us | breakage on update | pinned version, the port's contract suite on every bump, the container provider as a working alternative |
| Its Windows or macOS support is not what the README says | a system without a microVM | S8 and S9 first; fallbacks in order: WSL2, the container provider, QEMU as a later provider |
| A container is taken for a microVM | false sense of security | the `isolation` capability is shown on the thread, the page and in `sandbox_inspect`; K1 is recorded as failing; never chosen silently (D3) |
| Rootful Docker, or the host socket given to the harness | a container escape reaches the host as root | rootless recommended with a warning otherwise, a user namespace, the socket route off and labelled, K2 |
| Guest runtime too heavy | density and the 2 s start miss the budgets | minimal profile, warm pool, golden snapshot (section 3.11), measured in P0; exec-only fallback decided at P0 |
| Git sync misses something the user expects (ignored files, large binaries) | "my changes are not there" | the working tree commit includes untracked files; `sandbox_export` for the rest; `mount-readonly` for projects that need the live tree |
| A user turns on `mount` without seeing the consequence | host code execution through the project | off by default, per project, a permanent badge, and the explanation of section 3.5 in the setting |
| Snapshot clones share secrets or randomness | cross-sandbox leak | the guest agent re-identifies and reseeds after restore; S6 checks it; no secret is in a snapshot by construction |
| Model proxy unsupported by a provider | key must enter the guest | fallback key, spend-capped and short-lived, flagged in the UI |
| A machine cannot run any sandbox | the user believes a thread is isolated when it is not | the thread still runs, as today, with a permanent "Not sandboxed" badge and the fix one click away |
| multi-host changes underneath | rework | only two seams are touched: the `runtime-source` registry and the remote-call allowlist |
| Hypervisor, engine or kernel CVE | guest escape | pinned versions with checksums, an update policy in each provider README, never run as root |

## 8. Decisions taken (2026-11-14)

| Topic | Decision |
| --- | --- |
| Operating systems | Linux, macOS and Windows |
| Providers | microsandbox (microVM) and Docker/Podman containers, both built, both evaluated, the user chooses per host; Firecracker optional, later |
| Start time | at most 2 s from create to first prompt accepted |
| Project files | copied in and synchronised back through git by default; mounting the folder is possible but opt-in, because maximum security is the priority |
| Network | denied by default, with an allowlist |
| Default | a new thread runs in a sandbox by default |
| Retention | 24 h by default, configurable per host and per sandbox |
| Testing | as much as possible here, the container provider with Docker included; final tests (microsandbox, Podman, budgets) on the user's Fedora 44 machine, by committed report |
| No provider ready | the thread runs as today in a plain workspace, with a "Not sandboxed" badge |
| Rootless containers | recommended, with a warning when the engine is rootful; not required |

## 9. Still open

1. macOS and Windows test machines: none named yet. Their support stays "not verified" until one is available.
