# MicroVM sandboxes: isolated parallel agents on any host

Run each agent thread in its own microVM, on this machine or on a remote one, from a harness that runs on bare
metal or in Docker. Firecracker is the first provider; the design keeps the hypervisor behind a port so other
providers can follow.

**Status:** plan only. Nothing is built. Statements marked _(verify in P0)_ are assumptions that the first phase
must confirm or replace before any later phase starts.

**Resume here:** Phase 0, spike S1.

| Phase | Deliverable                                             | State       |
| ----- | ------------------------------------------------------- | ----------- |
| P0    | Feasibility spikes and decisions                        | not started |
| P1    | Provider port, orchestrator, fake provider (no KVM)     | not started |
| P2    | Firecracker provider on a bare Linux host               | not started |
| P3    | Workspace in, results out, credentials, egress          | not started |
| P4    | Harness in Docker                                       | not started |
| P5    | MicroVMs on a remote machine                            | not started |
| P6    | UI, agent tools, telemetry, docs                        | not started |
| P7    | Fast start (snapshots, warm pool) and density           | not started |
| P8    | Second provider, to prove the port                      | not started |

## 1. What we want

1. **Isolation.** Several agents work at once on one machine. No agent can read or change another agent's files,
   processes, network traffic or credentials, nor the machine's own.
2. **Three topologies, one behaviour.**
   - **T1 bare host:** the harness runs directly on a Linux machine and starts microVMs there.
   - **T2 Docker:** the harness runs in a container and still starts and reaches microVMs.
   - **T3 remote:** the harness runs anywhere (macOS included) and the microVMs run on another machine.
3. **It composes with multi-host.** One harness reaches several machines; each machine can run several sandboxes.
4. **Provider-neutral.** Firecracker first. Adding a provider means writing one package, not touching the
   orchestrator, the UI or multi-host.
5. **Stock DSH.** No core patch, as everywhere in this repository.

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

About Firecracker _(all to verify in P0 against the pinned release)_:

- Linux with KVM only, x86_64 and aarch64. It does not run on macOS or Windows. This alone makes T3 mandatory
  for a macOS user, and the provider port mandatory for a local macOS sandbox later.
- One process per microVM, configured over a Unix-socket HTTP API, normally started through `jailer` (chroot,
  cgroup, seccomp, own uid/gid, own network namespace).
- Block devices and network interfaces only. **No shared folders** (no virtio-fs, no 9p).
- `virtio-vsock`: the guest opens host↔guest streams without any network interface. On the host it is a Unix
  socket with a `CONNECT <port>` handshake.
- Snapshots (memory + device state) allow restoring a booted VM in well under a second. A restored clone shares
  its random state and identity with its source unless the guest reseeds.

About this cloud session: `/dev/kvm` is absent, so nothing here can boot a microVM. P1 is designed to be built
and tested without KVM; P2 onward needs a Linux machine with KVM (bare metal, or a cloud VM with nested
virtualization).

## 3. Design

### 3.1 The central choice: a sandbox is a guest runtime

Each microVM boots a **stock DSH runtime** with a small profile. The control Host treats it as one more
multi-host runtime and mirrors its Sessions, exactly as it does for a remote machine today.

Why this and not "run only the shell commands in the VM":

| Approach                                | What stays outside the VM                                    | Verdict                                                                    |
| --------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------- |
| **Guest runtime** (chosen)              | nothing of the agent: loop, file tools, shell, jobs, MCP     | full isolation; reuses the remote-thread path that already works           |
| Exec-only (swap the subprocess service) | the agent loop, file tools and MCP servers, in the Host      | a file tool or MCP server still reads the host; needs forks of every tool |

Cost of the choice: each sandbox pays a runtime's RAM and boot time. P7 addresses both. If P0 shows the guest
runtime cannot fit the budgets in section 6, exec-only becomes the fallback and this plan is revised before P1.

### 3.2 Components

```
control Host (T1 bare, or T2 in Docker)                    sandbox host (same machine in T1/T2, remote in T3)
┌───────────────────────────────────────────┐              ┌──────────────────────────────────────────────┐
│ @dshfiles/sandboxes      orchestrator, UI │── dshx API ──│ @dshfiles/sandboxes   (same package, Host half)│
│ @dshfiles/multi-host     mirrors Sessions │              │ @dshfiles/sandbox-firecracker   provider      │
│                                           │              │   firecracker + jailer, one per sandbox       │
│                                           │── gateway ───│   vsock ──► guest agent ──► guest DSH runtime │
└───────────────────────────────────────────┘              └──────────────────────────────────────────────┘
```

| Package                         | Role                                                                                              | Depends on                         |
| ------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `@dshfiles/sandbox-provider-port` | The contract a provider implements, as a dshx module. No behaviour.                              | dshx                               |
| `@dshfiles/sandboxes`           | Orchestrator: records, lifecycle, reconciliation, quotas, egress proxy, model proxy, page, tools. | the port, multi-host, sqlite-store |
| `@dshfiles/sandbox-firecracker` | Firecracker provider: images, jailer, API socket, vsock.                                          | the port                           |
| `@dshfiles/sandbox-fake`        | Test provider: runs the guest runtime as a plain local process in a scratch home.                | the port                           |
| `tooling/sandbox-image`         | Reproducible build of the kernel, base rootfs and guest agent.                                    | none at run time                   |

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

Capabilities: `snapshot`, `pause`, `vsock`, `nic`, `hotResize`, `nestedOk`, `architectures`.

`SandboxEndpoint` is the only thing the orchestrator needs to reach the guest: a host-side stream factory
(`open(port) → duplex`). For Firecracker it is the vsock Unix socket; for the fake provider it is a loopback TCP
port. The orchestrator turns it into a private loopback forward and hands multi-host a normal local launch URL,
so multi-host's existing `connectLocal` path is reused unchanged _(verify in P0)_.

Every failure is a typed error with a recovery sentence (the repository rule for user-facing errors), for
example: `kvm-unavailable` → "This machine has no /dev/kvm. Enable virtualization, or choose a remote sandbox
host under Hosts."

### 3.4 Inside the guest

- **Kernel:** a pinned `vmlinux`, checksum recorded, no modules.
- **Base rootfs (read-only, shared by every sandbox):** minimal Linux userland, the Node version from
  `.node-version`, the pinned DSH core, the built dshfiles bundles the `sandbox` profile needs, git and jj,
  the guest agent.
- **Per-sandbox overlay drive (writable, sparse):** mounted as an overlay over the base at boot. Deleting the
  sandbox deletes the file. Its size is the sandbox's disk quota.
- **Per-sandbox workspace drive:** holds the repository checkout (section 3.5).
- **Guest agent:** a small static binary started by init. It bridges vsock ports to guest loopback (the DSH
  runtime listens only on `127.0.0.1` inside the guest), reports readiness, applies boot parameters (runtime
  identity, launch token, proxy addresses), reseeds entropy after a snapshot restore, and shuts the guest down
  cleanly on request.
- **`sandbox` profile:** seeded like `profiles/web` but minimal: multi-host (to be mirrored), the VCS provider,
  the tools an agent needs. No Hosts page, no browser-only bundles. Target: under 300 MB RSS settled.

No secret, account file or host path is ever written into an image. `tooling/sandbox-image` fails its build if a
secret scanner finds one.

### 3.5 Getting work in and out without shared folders

Firecracker cannot mount a host folder, and a shared folder would defeat the isolation anyway.

- **In:** the orchestrator writes a `git bundle` of the chosen base revision onto the workspace drive before
  boot. The guest clones from it. No network is needed. Uncommitted files are **not** copied by default; the
  user may pick files explicitly, through the file-selection step multi-host already has for remote threads.
- **Out:** the guest pushes its commits to a per-sandbox bare repository on the sandbox host, over a vsock
  port that the orchestrator serves with `git upload-pack` / `receive-pack` restricted to that one repository.
  The existing Land flow then fetches from that bare repository like from any thread workspace.
- **Files that are not commits** (logs, screenshots, build output): pulled on request through a bounded
  `sandbox_export` call, size-capped, into a host folder the user names.

### 3.6 Network: no interface by default

The guest gets **no network interface** in v1. Everything crosses vsock:

- **Egress proxy:** the orchestrator runs an HTTP CONNECT proxy per sandbox, reachable on a vsock port; the
  guest's `HTTPS_PROXY` points at it. The proxy enforces a per-sandbox host allowlist (package registries and the
  repository's forge by default) and logs denials. Nothing else can leave.
- **No inbound.** A dev server in the guest is reached through an explicit, per-port forward the user opens.

Consequences: no tap device, no `CAP_NET_ADMIN`, no nftables on the host, so T2 (Docker) needs only `/dev/kvm`.
A real NIC (tap + NAT + default-deny firewall) is an optional later capability for tools that need raw sockets.

### 3.7 Credentials

The agent loop runs in the guest, so it needs to call a model. The real key must not enter the guest.

- **Model proxy (chosen):** the guest's provider is configured with a base URL on a vsock port and a
  per-sandbox token. The orchestrator's model proxy validates the token, attaches the real credential resolved
  on the Host through the existing `secret:ALIAS` path, and forwards. Revoking a sandbox revokes its token.
  Requires that the guest's provider configuration accepts a custom base URL _(verify in P0)_.
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
- **Retention:** a stopped sandbox keeps its drives for a configurable time (default 24 h) so work can still be
  landed, then is destroyed. Destroying a sandbox with unlanded commits requires an explicit opt-in argument.
- **Identity:** each sandbox gets a fresh runtime identity and launch token at create, pinned in multi-host's
  directory like any runtime. A different runtime behind the same endpoint is refused.

### 3.9 The three topologies

| | Where the provider runs | How the control Host reaches the guest | Host requirements |
| --- | --- | --- | --- |
| **T1 bare** | same Host process | vsock Unix socket → private loopback forward | Linux, `/dev/kvm` readable by the DSH user, jailer installed |
| **T2 Docker** | inside the container | same as T1; the VMs are children of the container | `--device /dev/kvm`, a writable volume for images and drives, cgroup v2 delegation for jailer _(verify in P0)_ |
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

### 3.10 What the user and the agent see

- **New thread:** the host chip lists, under each sandbox-capable host, a **Sandbox** destination. Auto
  placement may choose it when the user sets "isolate by default".
- **Sandboxes page** (under Hosts): one row per sandbox with host, state, thread, CPU, memory, disk, age and
  the actions Stop, Start, Export, Destroy, Logs.
- **Thread header:** a badge "Sandbox · `<host>`" and, when stopped, a Start control.
- **Agent tools** (parity rule): `sandbox_list`, `sandbox_inspect`, `sandbox_logs` (read-only);
  `sandbox_create`, `sandbox_start`, `sandbox_stop`, `sandbox_export` (write, "only when the user asked");
  `sandbox_destroy` with a mandatory explicit `confirmDestroy` argument and no default.
- **Readiness:** `sandbox_doctor` reports why a host cannot run sandboxes (no KVM, jailer missing, cgroup not
  delegated, disk too small) and the exact fix for each.

## 4. Phases

Each phase ends with an exit gate. A phase does not start before the previous gate is met.

### P0. Feasibility spikes and decisions

Throwaway scripts in a scratch directory, on a KVM Linux machine. No plugin code.

| Spike | Question | Done when |
| ----- | -------- | --------- |
| S1 | Does a stock DSH runtime boot in a Firecracker guest with a minimal profile? | a guest answers an authenticated RPC over vsock; boot time and settled RSS recorded |
| S2 | Does multi-host mirror a Session of that guest through a plain loopback forward? | a thread created from a scratch control Host runs one fake-model turn in the guest |
| S3 | Do file tools, MCP servers and the agent loop run in the Host process? | read from the installed core, with file and line; confirms or kills the exec-only fallback argument |
| S4 | Can a guest provider use a custom base URL, so the model proxy works? | one model call from the guest goes through a host proxy that adds the key |
| S5 | Does jailer work inside Docker with only `/dev/kvm`? | one microVM boots in a container without `--privileged`; the exact flags are written down |
| S6 | Snapshot restore: time, and is the runtime usable after an identity and entropy reset? | restore-to-ready time recorded; two clones show different identities and random output |
| S7 | Guest proxy-only networking: do `git`, `pnpm install` and a model call work with no NIC? | all three succeed through the vsock proxy; a non-allowlisted host is refused |

**Decisions to take with the user at the end of P0:** guest runtime vs exec-only (S1–S3); model proxy vs
injected key (S4); in-container VMs vs T3-only for Docker (S5); the guest image base (distribution, init).

**Exit gate:** a written `P0-findings.md` in this folder with every spike's command, numbers and verdict, the
four decisions, and section 6's budgets confirmed or revised.

### P1. Port, orchestrator and fake provider (no KVM needed)

1. `@dshfiles/sandbox-provider-port`: schemas, capability flags, typed errors, contract tests any provider must pass.
2. `@dshfiles/sandbox-fake`: runs the guest runtime as a local process in a scratch home, with a loopback endpoint.
3. `@dshfiles/sandboxes` Host half: records, state machine, reconciliation, quotas, retention, the loopback forward.
4. multi-host: the `runtime-source` registry module; ephemeral runtimes appear and disappear without touching `directory.json`.
5. Host API and the agent tools of section 3.10, bound to the dshx methods.

**Exit gate:** on a machine without KVM, an e2e journey creates a sandbox thread with the fake provider, runs
one fake-model turn, stops, restarts and destroys it; killing the Host mid-`booting` leaves no orphan process
after restart; the port's contract tests pass against the fake provider.

### P2. Firecracker provider on a bare Linux host (T1)

1. `tooling/sandbox-image`: pinned kernel and rootfs build, checksums, secret scan, guest agent.
2. `@dshfiles/sandbox-firecracker`: readiness (`describe`), image cache, jailer launch, API-socket configuration, vsock endpoint, bounded console log, stop and destroy.
3. Resource limits: vCPU, memory, drive sizes, virtio rate limiters, cgroup limits through jailer.

**Exit gate:** the port's contract tests pass against Firecracker; the P1 journey passes with the provider
swapped; isolation tests I1–I6 of section 5 pass.

### P3. Workspace, results, credentials, egress

1. Git bundle in; per-sandbox bare repository and restricted git service out; Land fetches from it.
2. Explicit file selection in; bounded `sandbox_export` out.
3. Egress proxy with allowlist and denial log; model proxy with per-sandbox tokens.

**Exit gate:** an agent in a sandbox clones, edits, commits and its work is landed on the host; a model call
succeeds while no real key exists anywhere in the guest (checked by scanning guest memory and disk for the key);
tests I7–I9 pass.

### P4. Harness in Docker (T2)

The compose file, the image for the harness itself, documentation of the exact flags from S5.

**Exit gate:** the P2 and P3 gates pass with the control Host running in the container.

### P5. Remote machine (T3)

1. Allowlist the `sandboxes` lifecycle calls in multi-host's remote plugin calls.
2. SSH: second forward to the guest endpoint. Pairing link: the scoped relay.
3. Auto placement counts a host's free sandbox quota.

**Exit gate:** from a control Host on another machine (and one on macOS), create, use, stop and destroy a
sandbox on a remote Linux host over SSH and over a pairing link; cutting the connection mid-turn loses no
work and the thread resumes; the relay refuses a non-sandbox target.

### P6. UI, tools, telemetry, docs

The Sandboxes page, chip entries, thread badge, `sandbox_doctor`; screenshots; the feature catalog with a
span per lifecycle transition; README per package; `docs/sandboxes.md`; `complete-plan` on the finished parts.

**Exit gate:** `check:screenshots`, `features:check`, the plugin boot check and one browser journey per
package pass.

### P7. Fast start and density

1. Golden snapshot of a booted, idle guest runtime; restore instead of boot; identity and entropy reset.
2. Warm pool of N restored sandboxes per host, bounded by quota.
3. Pause on idle, resume on prompt.

**Exit gate:** the budgets of section 6 are met and recorded in `docs/performance.md` with before and after.

### P8. A second provider

One of: Cloud Hypervisor (Linux, has virtio-fs), Apple Virtualization (local macOS), or a hosted sandbox API.
Chosen with the user after P5.

**Exit gate:** the port's contract tests and the P1 journey pass with no change outside the new package.

## 5. How we know it works: acceptance tests

Automated, in `plugins/@dshfiles/sandboxes/tests/acceptance/`, run on a KVM machine. Each runs two sandboxes,
A and B, on one host unless stated. A test passes only on the stated observation.

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
| C3 | Provider neutrality | the port's contract suite against fake, Firecracker and the P8 provider | same suite, all pass |

Negative tests on the control plane: a wrong runtime identity behind an endpoint is refused; the scoped relay
refuses a non-sandbox target; a sandbox on host X cannot be controlled with host Y's link credential.

## 6. Budgets

Measured with the existing probes, recorded in `docs/performance.md`. Revised once after P0.

| Measure | Target after P2 (cold boot) | Target after P7 (snapshot) |
| --- | --- | --- |
| Create → first prompt accepted | ≤ 15 s | ≤ 1.5 s |
| Guest runtime settled RSS | ≤ 300 MB | ≤ 300 MB |
| Host overhead per idle sandbox (outside guest memory) | ≤ 30 MB | ≤ 30 MB |
| Idle sandbox CPU on the host | ≤ 0.5 % of a core | paused: 0 % |
| Disk per sandbox before work | ≤ 50 MB (sparse overlay) | same |
| Sandboxes on a 16 GB / 8-core host | 8 active | 8 active + 16 paused |

## 7. Risks

| Risk | Effect | Mitigation |
| --- | --- | --- |
| Guest runtime too heavy | density and start time miss the budgets | minimal profile (P0 S1), snapshots (P7); exec-only fallback decided at P0 |
| Jailer needs privileges Docker will not give | T2 in-container impossible | S5 early; T3 with the Docker host as remote machine covers the need |
| Snapshot clones share secrets or randomness | cross-sandbox leak | guest agent reseeds and re-identifies after restore; I5 and S6 check it; no secret is in the snapshot by construction (model proxy) |
| Model proxy unsupported by a provider | key must enter the guest | fallback key, spend-capped and short-lived, flagged in the UI |
| No KVM on the user's machine (macOS, some clouds) | no local sandbox | T3 now, P8 provider later; `sandbox_doctor` says so with the fix |
| multi-host changes underneath | rework | only two seams are touched: the `runtime-source` registry and the remote-call allowlist |
| Kernel or Firecracker CVE | guest escape | pinned versions with checksums, an update policy in the provider README, jailer and seccomp always on, never run as root |

## 8. Questions for the user

1. Which Linux machine with KVM do we develop and test on (bare metal, or a cloud VM with nested virtualization)?
2. Is "no network interface, proxy only" acceptable as the v1 default, with a real NIC as a later option?
3. Should Auto placement prefer a sandbox by default, or only when the user asks?
4. For macOS as the control machine: is T3 enough until P8, or is a local macOS provider a priority?
5. How long should a stopped sandbox keep its drives before it is destroyed (proposed: 24 h)?
