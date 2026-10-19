# STUDY-168 — Running app code in a sandboxed process (exploratory)

- **Status:** exploratory. It is research with a prototype and measurements, and nothing in it is for merge. Default
  code paths are unchanged. The prototype lives in `bench/process-sandbox/` and is reached only by its own scripts
  and opt-in tests.
- **Convex source read:** commit `4577b9031cbe32ddffbf8b6a61a07fe4a5dd6922` of get-convex/convex-backend.
- **Related:**
  - ARCH-01 §6 open decision 3 (sandboxing).
  - [STUDY-35](STUDY-35-push-and-deploy.md) P1/P2: DV-164 (one `vm` context per code version, which is not a
    security boundary) and DV-165 (module state lives as long as the code version).
  - [STUDY-41](STUDY-41-nested-calls-and-execution-limit.md) N5: DV-208 (the 1 s limit is cooperative).
  - [STUDY-152](STUDY-152-components-restudy.md) C2: DV-492 (component modules are evaluated once per version).
  - DV-87 and DV-500 (`"use node"` actions run in the server's own Bun process).
  - [STUDY-80](STUDY-80-outbound-requests.md): the SSRF screen on action `fetch`.

The question: can bunvex run an app's functions in **a separate, OS-sandboxed Bun process per deployment**
("option C"), as a real security boundary like Convex's V8 isolates, and at what cost? The owner wants to judge
whether this is viable for a future multi-tenant bunvex cloud.

Short answer: **yes, it is viable as a cloud mode, and it should not be the default for self-hosting.** It blocks
every escape that works today. It enforces a real timeout and a real memory cap, and the host survives both. Idle,
it costs about 5.5 MiB of RAM per deployment. The price is a host round trip on every `ctx` call: about 40 µs with
host and child on the same CPU, and about 240 µs on this VPS when the kernel puts them on different CPUs. On the
two-vCPU VPS, that cost 30–40 % of in-process throughput. Over HTTP the difference was 1–15 %. Section 7 has the
details.

---

## 1. How Convex does it

### 1.1 Isolates and the ops-only bridge

- **The engine.** Convex embeds V8 through `deno_core::v8`, using Convex's own fork of rusty_v8
  (`Cargo.toml:72,283`). It drives raw V8 without deno's `JsRuntime`. `initialize_v8()` runs once per process
  (`crates/isolate/src/client.rs:469-537`). It starts the platform with `V8_THREADS` threads and sets these flags:
  - `--disallow-code-generation-from-strings`, which turns off `eval` and `new Function` (`client.rs:510`);
  - `--stack-size=2048`;
  - `--no-wasm-async-compilation` (`client.rs:506-517`).
- **The isolate.** `Isolate::new` (`crates/isolate/src/isolate.rs:168-237`) builds it through
  `udf_runtime::create_isolate_with_udf_runtime` (`crates/isolate/src/udf_runtime.rs:43-59`), with these settings:
  - **Heap limits:** `heap_limits(INITIAL_HEAP_SIZE, ISOLATE_MAX_USER_HEAP_SIZE + ISOLATE_MAX_HEAP_EXTRA_SIZE)`.
    That is 64 MiB of user heap plus 32 MiB for state kept between contexts (`crates/common/src/knobs.rs:1162-1169`).
  - **ArrayBuffers:** a custom allocator caps their total at 64 MiB
    (`crates/isolate/src/array_buffer_allocator.rs:102-117`, `knobs.rs:1171-1173`).
  - **Modules:** `import.meta` and dynamic `import()` throw (`isolate.rs:188,192`).
  - **Other:** `Atomics.wait` is off (`isolate.rs:195`), and microtasks run explicitly (`isolate.rs:197`).
- **Out of memory.** A near-heap-limit callback (`isolate.rs:208-211`, `403-429`) terminates the isolate with
  `OutOfMemory`. It then raises the limit so that V8 does not abort the process. The app sees
  `JavaScript execution ran out of memory (maximum memory usage: 64 MB)` (`crates/isolate/src/termination.rs:346-347`).
- **The bridge.** Each fresh context gets four native functions on `globalThis.Convex`: `syscall`, `asyncSyscall`,
  `op` and `asyncOp` (`crates/isolate/src/request_scope.rs:228-298`).
  - Database calls are JSON-in/JSON-out syscalls such as `1.0/get`, `1.0/insert`, `1.0/queryPage` and `1.0/runUdf`
    (`crates/isolate/src/environment/udf/syscall.rs:133-141`, `async_syscall.rs:251-253,681-713`).
  - The ops cover randomness, time, crypto, console and `fetch` (`crates/isolate/src/ops/mod.rs:323-489`).
  - Any error that is not deterministic terminates the isolate. The app then sees "Convex encountered an internal
    error" (`request_scope.rs:348-405`, `strings.rs:74`).
- **No host objects.** JS gets values only, as JSON or V8 values built from them. It never holds a reference into
  the host. `process` is `{ env }`, and each read of `env` is an op (`npm-packages/udf-runtime/src/00_misc.ts:16-35`).
  There is no `require`, filesystem or socket.

### 1.2 The per-request context, the pool and the limits

- **A fresh context per request.**
  - `IsolateWorker::service_requests` (`client.rs:1523-1621`) keeps one isolate. For each request it hands out a
    fresh `v8::Context` from the startup snapshot (`crates/isolate/src/context_cache.rs:83-114`,
    `udf_runtime.rs:80-196`).
  - A module that exports `experimental_reuseContext` keeps its context, but only after successful runs, and only
    while its import-time reads still hold (`environment/udf/mod.rs:783-897`, `context_cache.rs:116-176`).
- **No reuse across clients.** An isolate is never shared between clients: "We don't allow an isolate to be reused
  across clients for security isolation." (`client.rs:1577-1587`).
- **Recycling.** An isolate is recycled when any of these happens (`client.rs:1660-1689`, `isolate.rs:280-321`):
  - a termination (timeout, out of memory, system error);
  - free heap drops below 64 MiB;
  - a context leaks;
  - `ISOLATE_MAX_LIFETIME_SECONDS` (3600) passes;
  - `ISOLATE_IDLE_TIMEOUT_SECONDS` (600) of idle time passes.
- **The pool.** The pool knobs are `MAX_ISOLATE_WORKERS` (300) and `V8_THREADS` (the number of cores)
  (`knobs.rs:1020-1053`). The CoDel queue holds 2000 (`knobs.rs:1002-1018`). One client gets at most 50 % of the
  workers (`FUNRUN_SCHEDULER_MAX_PERCENT_PER_CLIENT`, `knobs.rs:1399-1400`; `client.rs:1190-1211`).
- **Timeouts.** A query or mutation has 1 s of user time (`DATABASE_UDF_USER_TIMEOUT_SECONDS`, `knobs.rs:983-985`)
  and 15 s of system time (`knobs.rs:995-996`). A V8 action has 1800 s and a Node action 600 s
  (`knobs.rs:208-218`).
  - **Enforcement.** An `isolate_timeout` task (`crates/isolate/src/timeout.rs:180-206,341-361`) extends the
    deadline by the time spent paused in async syscalls (`timeout.rs:101-112`). When the deadline passes, it calls
    `v8::IsolateHandle::terminate_execution()` (`termination.rs:89-99,169-187`).
  - **Messages.** The app sees `Function execution timed out (maximum duration: 1s)` (`termination.rs:349-351`).
    Too much syscall time gives `Your request timed out performing too many system operations.`
    (`timeout.rs:46-47`).
- **Determinism.** `Math.random` comes from a ChaCha12 PRNG seeded per execution
  (`crates/isolate/src/environment/udf/phase.rs:449-472`, seed drawn in `crates/function_runner/src/server.rs:366-371`).
  `Date.now()` is frozen at the transaction's timestamp (`crates/isolate/src/ops/time.rs:34-43`).
- **Transaction state.** The read set, the writes and OCC stay in Rust, in `UdfPhase { tx }` (`phase.rs:86-121`;
  `crates/database/src/transaction.rs:169,184`). JS only ever sees syscall results.

### 1.3 Node actions: a separate process

- **The executor.** `LocalNodeExecutor` writes the bundled executor to a temporary directory and spawns `node` with
  an IPC socket path (`crates/node_executor/src/local.rs:71-81,129-200`). It checks `/health` before the first use.
- **The protocol.** It is HTTP over the Unix socket: `POST /invoke` with a JSON body, answered as streamed ndjson
  (`local.rs:282-331`; `npm-packages/node-executor/src/local.ts:18-58`).
  - One Node process serves concurrent requests.
  - When the process crashes or reports `exitingProcess`, the backend starts a new one on the next invoke.
- **Syscalls.** Node actions call back into the backend over HTTP, to `/api/actions/query|mutation|schedule_job|…`,
  with a callback token (`npm-packages/node-executor/src/syscalls.ts:325-400,673-1150`;
  `crates/local_backend/src/node_action_callbacks.rs:639-690`).
- **Timeouts.** In Node, a `Promise.race` gives ``Action `x` execution timed out (maximum duration 600s)``
  (`executor.ts:427-471`). The backend's own limit is `NODE_ACTION_USER_TIMEOUT + 5 s` (`local_backend/src/lib.rs:206-213`).
- **What it does not isolate.**
  - Locally there is no memory limit, and no `--max-old-space-size`.
  - The environment is trimmed "for consistency between environments, not for security" (`executor.ts:85-108`).
  - An unhandled rejection fails the action and exits the process (`executor.ts:137-195`). DV-500 is the bunvex
    difference here.

### 1.4 What Convex Cloud adds

Two things, from the public source and docs:

- **Funrun.** Queries, mutations, HTTP actions and V8 actions run in a separate function-runner service called
  Funrun. It is not in the open-source tree. The knob `UDF_USE_FUNRUN` (default true) chooses between it and
  `InProcessFunctionRunner` (`knobs.rs:1305-1307`; `crates/function_runner/src/lib.rs:84,150`;
  `in_process_function_runner.rs:112-154`).
- **Lambda.** Node actions run on AWS Lambda, which isolates with Firecracker VMs
  (`npm-packages/node-executor/src/aws_lambda.ts:18-55`, line 27). The Lambda memory limits are 512 MiB static and
  4096 MiB dynamic (`knobs.rs:1473-1523`). Credentials are protected by IAM policies (`executor.ts:94-97`).

**There is no OS-level sandboxing in the open-source backend.** A search for seccomp, namespaces, cgroups, nsjail,
landlock and setrlimit finds nothing. The boundary is V8 alone: isolates, contexts, heap limits and termination.
Cloud Node actions add Firecracker.

## 2. What an app can observe

What this changes for an app, and what option C must keep:

- **Results stay the same.** That covers values, errors with their `data`, read sets and so reactivity, OCC
  retries, and determinism (one frozen time and a seeded `Math.random` per execution).
- **Limits become real.** A synchronous infinite loop fails with
  `Function execution timed out (maximum duration: 1s)`, and the deployment keeps serving. Allocating past the cap
  fails with `JavaScript execution ran out of memory (maximum memory usage: N MB)`.
- **The boundary becomes real.** Today none of these limits exists for code running in a `vm` context:
  - `process`, the environment (the admin key, database credentials), the filesystem, sockets to the host's own
    ports and other processes are all out of reach;
  - a fork bomb is stopped by the pid limit.
- **Timing changes.** Every `ctx` call costs an IPC round trip (§5), and the first call after a push runs on cold
  code.

## 3. The threat model

| | Self-hosted (single tenant) | Cloud (multi-tenant) |
|---|---|---|
| Who writes the code | The operator | Untrusted customers |
| Data of other tenants | Not applicable | **Must protect.** One deployment per process; the host answers only the ops of the calling deployment's own engine |
| Host secrets (admin key, instance secret, DB creds, env) | Nice to have | **Must protect.** The child has an empty environment, no host files, no `/proc` of the host |
| Filesystem | Nice to have | **Must protect.** Only the bun binary, its libraries, the runner and the app's own files, all read-only; `/tmp` is a private tmpfs |
| Network egress | `fetch` goes through the SSRF screen (STUDY-80) | **Must protect.** The child has no network (its own empty net namespace, and seccomp refuses non-Unix sockets); action `fetch` is an op the host screens |
| Signalling or tracing the host | Not a concern | **Must protect.** pid namespace; seccomp refuses `ptrace`, `process_vm_*` and `kcmp` |
| CPU starvation | A bug can hang the server (DV-208) | **Must protect.** A real timeout (kill), plus `cpu.max` per deployment |
| Memory starvation | A bug can OOM the server | **Must protect.** `memory.max` per deployment; the host survives |
| Fork bombs | Not a concern | **Must protect.** `pids.max` |
| Kernel bugs | Not a concern | Residual risk. The seccomp deny list narrows the attack surface; gVisor or Firecracker is the next step if a container escape is in scope |

- **Self-hosted.** The app's code is the operator's own code. The sandbox protects the server from the app's bugs
  (loops, leaks), not from a malicious author.
- **Cloud.** The boundary is the product: a tenant's code must not reach other tenants, the host, or the network
  except through the screened `fetch`.

## 4. Design space for C

### 4.1 Alternatives (baseline)

**A — a hardened `vm`.** Not a boundary. Any object the host hands in leads back to the host realm:
`ctx.constructor.constructor("return process")()` returns the real `process`. The `escapes` probe in
`bench/process-sandbox/app/sb.ts` does exactly this, and it escaped on every count (§6).
- Closing it would take a full membrane: no host object would ever cross, so everything would have to be copied.
  Even then, JSC gives no heap cap, and a loop can only be interrupted by `vm`'s `timeout` watchdog.
- Everything would still share one address space. **Not viable as a boundary.** "Not possible."

**B — a Bun Worker.** A Worker has its own heap and event loop, but it is in the same process. Checked on the Mac
with Bun 1.4.2:
- `worker.terminate()` stops a synchronous loop in 1.8 ms;
- `resourceLimits: { maxOldGenerationSizeMb: 64 }` is ignored (the process grew to 1.4 GiB in 1.5 s);
- inside the Worker, `process.env` and `node:fs` are the host's.

Its round trip (§5) is no cheaper than a child process's. B gives the timeout and nothing else. **Not a boundary.**

**D — an embedded QuickJS (WASM).** A real in-process boundary: its own heap with a hard limit and an interrupt
handler, and no host objects unless they are passed in.
- Host calls are cheap: they are synchronous in-process calls.
- But it is an interpreter. It is much slower on JS-heavy code than JSC's JIT, and its ES support, `Intl` and
  timers are not JSC's.
- Apps would see a different engine from Bun, which is a large parity cost.
- Not measured here. It is the right comparison only if per-op latency must be in-process.

**C — a sandboxed Bun process** is the subject of the rest of this study.

### 4.2 Granularity

| Choice | Isolation | Cost | Notes |
|---|---|---|---|
| One process per **deployment** (prototyped) | Tenant from tenant | ~5.5 MiB idle each (§5.5) | A kill (timeout, OOM) fails every in-flight call of that deployment, not just the guilty one |
| One per **code version** | Same, plus versions apart | Two processes during a push | This is what a push already does in the prototype: a new child per push, then switch, then drain the old one (§4.5). It frees old code (DV-164's reason) for free |
| A **pool** of K processes per deployment, one request each | Request from request (Convex's isolate model) | K × memory; no concurrency inside a process | Kills are precise, `Date`/`Math.random` need no async context, and a fresh process per request could even give DV-165 (fresh state), at ~60 ms each (too slow per request; a pre-warmed spare helps) |
| A shared pool across deployments | **None between tenants** | Least memory | Rejected: Convex itself refuses to reuse an isolate across clients (`client.rs:1577-1587`) |

**Recommended for a cloud:** one process per deployment and code version, as prototyped. Concurrency inside it is
the same as today, with a per-call async context. A small pool per deployment can come later, for hot tenants and
for precise kills.

### 4.3 The bridge

**What the child needs from the host.** Everything that touches state or the outside world:
- `db.get`, `db.query(...).take/first/unique/collect/paginate/count` (the whole chain is recorded, and so are the
  index range and filter expressions);
- `insert`, `patch`, `replace`, `delete` and `normalizeId`;
- `db.system.*`;
- `auth.getUserIdentity`;
- `scheduler.runAfter/runAt/cancel`;
- `runQuery`, `runMutation` and `runAction`;
- `fetch` (actions only).

Not built in the prototype, but the same shape: storage (bytes over the wire), vector and text search, HTTP
actions, components, and log lines.

All of it runs **on the host, inside the host's transaction**:
- the host registers a stand-in `query`/`mutation`/`action` for each child function;
- the engine runs the stand-in as it runs any function (read set, OCC retry, commit, query cache, scheduler);
- the stand-in forwards the handler to the child, and answers each op with the real `ctx`, back in the
  execution's async context (`AsyncResource.runInAsyncScope`). The engine's per-execution state therefore applies.

**Every op is checked on the host:**
- the call id must be running;
- the op must be allowed for the function's kind. A query cannot insert, whatever the child sends: the
  `forgeInsert` test forges raw insert ops for 5000 call ids from inside a query, and every one is refused.

A real executor also needs size limits per message, as Convex's 16 MiB argument and result caps.

**Transport.** Measured on the VPS, mean / p50 / p99 of one small round trip, in µs
(`results/transport*.jsonl`):

| Transport | Unpinned | Host and child on one CPU |
|---|---|---|
| Plain call | 0.23 / 0.07 / 0.39 | 0.13 / 0.07 / 0.21 |
| `vm` context call (today) | 0.41 / 0.27 / 1.14 | 0.68 / 0.38 / 1.52 |
| Worker `postMessage` (B) | 168.6 / 178.9 / 827 | 22.8 / 20.5 / 52 |
| `Bun.spawn` IPC, JSON | **125.2 / 45.5 / 726** | **27.7 / 25.1 / 52** |
| `Bun.spawn` IPC, structured clone | 158.3 / 93.5 / 872 | 36.6 / 32.4 / 84 |
| stdin/stdout, length-prefixed `bun:jsc` frames | 252.8 / 245.1 / 1102 | 69.2 / 59.3 / 145 |
| Unix socket, the same frames | 157.5 / 79.2 / 909 | 61.5 / 43.1 / 184 |

The prototype uses **Bun's IPC channel with JSON serialization**:
- it is the fastest of these;
- it passes through bubblewrap as an inherited file descriptor (`NODE_CHANNEL_FD=3`);
- it does not corrupt anything when the app writes to stdout;
- on the host it parses untrusted input with `JSON.parse` only, not a structured-clone deserializer.

Bunvex values that JSON lacks (int64, bytes) are tagged, as the value JSON format tags them (`wire.ts`). Shared
memory has no API in Bun that crosses processes, so it was not tried.

**The real cost is wakeup latency.** On this KVM guest, a round trip between two processes on different vCPUs
costs 3–5× more than one on the same vCPU. The kernel puts them on different vCPUs when both are free. Section 5.3
shows the effect. Remedies:
- pin each deployment's child to its host thread's CPU (`taskset` or `sched_setaffinity`);
- spin briefly before blocking;
- or batch ops.

### 4.4 Determinism and read sets

Both stay on the host:
- **The read set and OCC.** The child never sees a transaction, only values. Reactivity and OCC were unchanged in
  every check (the parity test in §6 compares results with the `vm` executor).
- **Determinism.** Each call carries a seed and a time drawn from the host's deterministic globals inside the
  execution, so they are reproducible per execution, as Convex draws them per execution. The child installs
  `Date`, `Date.now` and `Math.random` per call through `AsyncLocalStorage`, as `core/determinism.ts` does today.
  `crypto.getRandomValues`, timers and `fetch` in queries would be wired the same way (not done in the prototype).

### 4.5 Hot swap and pushes

A push starts a new child with the new code. When it reports its function list (Convex's analyze), new calls
switch to it. The old child is killed once its in-flight calls end.

| | p50 | p99 |
|---|---|---|
| Push to switch, bwrap | 41 ms | 51 ms |
| Push, no sandbox | 24 ms | 34 ms |
| Today: `CodeVersion.load` of the same bundle | 2.2–4.1 ms | 4.3–10 ms |
| First call after the switch (cold JIT) | 6–12 ms | |

Old code is freed with its process, which is DV-164's goal, with no GC dependence.

### 4.6 Crash and kill semantics

| Event | Prototype | Convex's message |
|---|---|---|
| A user timeout with JS running (the child is not in an op) | The host's timer kills the child with SIGKILL; the call fails | `Function execution timed out (maximum duration: 1s)` |
| OOM (cgroup `memory.events` `oom_kill` > 0 at exit) | Every in-flight call fails | `JavaScript execution ran out of memory (maximum memory usage: N MB)` |
| Any other exit | Every in-flight call fails | A system error ("…internal error" in Convex; the prototype's words are bunvex's own) |
| After any death | The next call waits for a fresh child (a warm spare would hide this) | |

The user-time budget pauses while the host runs an op, as Convex pauses in syscalls (§1.2).

**Two divergences from Convex's semantics:**
1. **Kills are per process, not per request.** A deployment's other in-flight calls fail with it. Convex terminates
   one isolate, and so one request. Only a pool of one-request processes (§4.2) avoids this.
2. **The cgroup cap covers the whole process.** The Bun runtime takes about 7–30 MiB of it (§5.5), so "64 MB of
   heap" maps to roughly a 96 MiB cgroup. Convex's own hard limit, including the extra 32 MiB, is 96 MiB.

**A finding to fix: user time also counts the IPC.** The engine's cooperative timer counts the time a stand-in
waits for the child as user time, IPC transit included. A mutation of 10 000 inserts fits in 1 s in-process, but
took over 1 s in the sandbox, and the bench had to seed in batches of 1000. The real executor must take user time
from the child's own accounting, its JS time excluding op waits, and treat round trips as paused time.

### 4.7 Linux sandboxing (prototyped)

`host.ts` `bwrapCommand` wraps the child in four layers:

- **bubblewrap.**
  - `--unshare-all` gives new user, mount, pid, net, ipc, uts and cgroup namespaces.
  - The child runs as uid and gid 65534, with `--cap-drop ALL`, `--die-with-parent`, `--new-session` and
    `--clearenv`.
  - The mounts are read-only `/usr/lib/x86_64-linux-gnu`, `/usr/lib64`, the bun binary as `/bun`, the runner, the
    app's directory and `bunvex/values`, plus a private `/dev`, `/proc` (the new pid namespace's) and a tmpfs
    `/tmp`.
  - There is no `/bin`, `/etc` or `/root`, and no shell: the only executable is `/bun`.
- **seccomp.** `gen-seccomp.py` builds the filter with libseccomp and passes it to `bwrap --seccomp`. Default
  allow, with EPERM for:
  - tracing (`ptrace`, `process_vm_*`, `kcmp`, `pidfd_getfd`);
  - mounting and the new mount API;
  - `unshare`, `setns`, and `clone` with namespace flags (`clone3` gets ENOSYS);
  - module loading, kexec, `bpf`, `perf_event_open`, `userfaultfd`, keyrings, clock setting and `personality`;
  - `socket()` for any family other than AF_UNIX.
- **cgroup v2.** One leaf per child under `/sys/fs/cgroup/bunvex-study/` sets `memory.max`, `memory.swap.max=0`,
  `pids.max` (64 in the prototype; Bun has about 10 threads) and `cpu.max`. A shell wrapper writes `$$` into
  `cgroup.procs` before it `exec`s bwrap, so the child never runs outside the cgroup.
- **Landlock.** Not used. With a mount namespace that shows almost nothing, it would add little. It is worth having
  where user namespaces are not allowed.

**nsjail** packs the same layers into one tool. Doing it directly from Bun is not possible, because Bun has no
`clone`/`unshare`/`seccomp` API. A small static helper could do it, but bubblewrap is that helper, already packaged.

**Privilege.** The VPS ran everything as root. In production, the host would run unprivileged, with a delegated
cgroup subtree (systemd `Delegate=yes`). bubblewrap's user namespaces also need
`kernel.apparmor_restrict_unprivileged_userns=0`, an AppArmor profile for bwrap, or a setuid bwrap: Ubuntu 24.04
restricts unprivileged user namespaces by default.

### 4.8 macOS dev mode

`sandbox: "seatbelt"` (`host.ts` `seatbeltCommand`) runs the child under `sandbox-exec` with a profile that denies:
- the network (except Unix sockets);
- all writes;
- reads under `$HOME`, `/private/tmp` and `/private/var/folders`, except the bun binary, the runner, the app and
  `bunvex/values`;
- `process-fork`.

Checked on the Mac (Bun 1.4.2). The child starts in 21 ms, and functions work. The probes:
- **blocked:** filesystem reads and writes in the home directory (EPERM), connecting to the host's port, spawning
  (EPERM on `posix_spawn`), and the environment;
- **not blocked:** `kill(hostPid, 0)` still succeeded. The profile's `(deny signal (target others))` did not stop a
  signal-0 probe; a real signal was not tried.

There are no memory or pid limits and no namespaces. `sandbox-exec` is deprecated, though still shipped. It is good
enough as a dev guard, so dev and cloud run the same code path. **It is not a boundary.** "No sandbox" (a plain
child process) is the other honest dev default.

## 5. Measurements

### 5.1 How and where

**The machine.** All numbers come from the Linux test VPS (`results/vps.json`) unless marked "Mac":

| CPU | RAM | OS | Kernel | Bun | bubblewrap |
|---|---|---|---|---|---|
| AMD EPYC 9354P, **2 vCPUs** | 7.8 GiB | Ubuntu 24.04.5 | 6.8.0-147-generic | 1.4.3 | 0.9.0 |

The Mac ran only short functional checks.

**The modes:**
- **vm** is today's executor: `app/sb.ts` is bundled as a push bundles it, loaded into a real `CodeVersion`
  (`node:vm`), and registered.
- **process** is the prototype's host and child with no OS sandbox.
- **bwrap** is the same inside bubblewrap, seccomp and a cgroup (128 MiB in the benches).

**What runs.** The real engine (`Engine`, memory persistence) and the real `Functions`, called in-process. Every
`ctx.db` call in the sandboxed modes goes over IPC to the real transaction. That is real execution, not a
simulation, except for these caveats:
- the stand-ins carry no argument validators, which slightly favours C;
- query iteration is collected, not streamed;
- storage, search, HTTP actions and components are not wired.

**Reproducing.** `bench/process-sandbox/bench.ts <mode>`, `density.ts`, `http-workload.ts` and
`transport-bench.ts`, with the raw JSON lines in `bench/process-sandbox/results/`.

**Unpinned vs pinned.** "Unpinned" runs leave scheduling to the kernel. "Pinned" runs put the whole benchmark,
child included, on one vCPU (`taskset -c 0`).

### 5.2 Per-call overhead (µs, p50 / mean; sequential, 3000 calls after warm-up)

| Function | vm (today) | bwrap, unpinned | bwrap, pinned | vm, pinned |
|---|---|---|---|---|
| Empty query | 20 / 58 | 102 / 214 | 59 / 87 | 16 / 46 |
| 1 × `db.get` | 42 / 55 | 163 / 329 | 128 / 183 | 43 / 81 |
| 10 × `db.get` | 155 / 194 | 2817 / 2548 | 574 / 669 | 159 / 244 |
| 100 × `db.get` | 1235 / 1357 | 25104 / 24347 | 5187 / 5469 | 1219 / 1437 |
| Query page of 1 | 50 / 76 | 465 / 501 | 170 / 231 | 48 / 119 |
| Query page of 10 | 76 / 90 | 474 / 528 | 219 / 311 | 75 / 137 |
| Query page of 100 | 361 / 382 | 1023 / 1147 | 684 / 784 | 342 / 385 |
| Insert mutation (commit) | 90 / 144 | 286 / 499 | 207 / 313 | 100 / 179 |
| Read + patch mutation | 127 / 178 | 1011 / 1232 | 307 / 448 | 135 / 232 |

- **Per op.** The marginal cost of one `ctx` op is about **40 µs pinned** and about **240 µs unpinned** on this VPS.
  The Mac measured about 30 µs. In-process it is about 12 µs.
- **Per call.** The fixed cost of a call is about 45–80 µs.
- **Pages.** A page costs one round trip whatever its size: a page of 100 adds about 0.35–0.65 ms, mostly
  serialization.
- **The mode without a sandbox** measured the same as bwrap (`results/bench-process.jsonl`): **the cost is the
  process boundary, not the sandbox layers.**

### 5.3 Throughput under concurrency (unpinned, in-process callers, 5 s per point)

| Function, concurrency | vm: calls/s, p50 / p99 ms | bwrap: calls/s, p50 / p99 ms | Change |
|---|---|---|---|
| listByTenant (page of 20), 1 | 3330, 0.25 / 1.36 | 1018, 0.89 / 3.02 | −69 % |
| listByTenant, 8 | 3824, 2.02 / 4.31 | 2608, 2.61 / 9.64 | −32 % |
| listByTenant, 32 | 3322, 9.22 / 22.7 | 2506, 11.6 / 32.0 | −25 % |
| listByTenant, 64 | 3744, 16.2 / 32.0 | 2361, 25.4 / 51.5 | −37 % |
| insertItem, 1 | 8700, 0.08 / 0.92 | 1732, 0.54 / 2.42 | −80 % |
| insertItem, 8 | 9829, 0.59 / 7.85 | 5198, 1.20 / 9.29 | −47 % |
| insertItem, 32 | 9286, 2.48 / 19.5 | 6570, 3.79 / 19.4 | −29 % |
| insertItem, 64 | 9907, 5.13 / 28.7 | 6844, 7.49 / 30.8 | −31 % |

The pinned runs (`results/bench-*-pinned.jsonl`) have better sequential latency, but only one vCPU for host and
child together, so at concurrency 8 to 64 they reach about 1,900–2,100 calls/s for queries and 4,200–4,700 for
inserts. The two vCPUs are shared by the host's engine, the child, and the load in these runs. A production host
would have more cores, and the child's work would overlap with the engine's.

### 5.4 Realistic workload over HTTP

The same server stack as production (`createServer`), the convex-bench query `listByTenant` and its insert, 80 % /
20 %, for 10 s. The load generator runs in the same process on the same two vCPUs (`results/http.jsonl`):

| Concurrency | vm: req/s, p50 / p99 ms | bwrap: req/s, p50 / p99 ms | Change |
|---|---|---|---|
| 8 | 1861, 3.45 / 13.8 | 1579, 4.51 / 14.8 | −15 % |
| 32 | 1965, 13.7 / 46.1 | 1945, 15.1 / 37.8 | −1 % |

With HTTP, JSON and the sync layer in the path, the executor's IPC is a smaller share. This is the number closest
to what an app would see.

### 5.5 Memory and density

| What | RSS | PSS | cgroup `memory.current` |
|---|---|---|---|
| One child, idle (after load) | 37.6 MiB | 19.8 MiB | 7.5 MiB |
| One child, after the load runs | 56.6 MiB | 37.8 MiB | 24.8 MiB |
| One child, peak under load | 62.4 MiB | 43.7 MiB | 30.8 MiB |

- **Density.** N idle children were started at once, each called once, and the drop in `MemAvailable` was
  measured (`results/density.jsonl`):

  | N | Per child (MemAvailable) | Per child (PSS) | Per GiB | All N ready |
  |---|---|---|---|---|
  | 10 | 6.8 MiB | 6.1 MiB | 150 | 0.22 s |
  | 50 | 5.8 MiB | 4.6 MiB | 175 | 1.0 s |
  | 100 | 5.5 MiB | 4.4 MiB | **187** | 2.1 s |

  The bun binary's pages are shared between children, which is why one child's RSS (38 MiB) is far above its
  marginal cost.
- **Busy deployments** cost about 25–45 MiB each (PSS under load), or **about 25–40 per GiB**.
- **Today, for comparison:** one `CodeVersion` lives in the server's heap and has no separate cost.

### 5.6 Cold start, kill and memory cap

- **Cold start.** Spawn to ready (the function list received):
  - one at a time: 55–75 ms for bwrap, 60–75 ms with no sandbox, and 16–23 ms on the Mac;
  - with 100 starting at once on two vCPUs: 0.4–1.6 s each.
- **Infinite loop** (`sb:spin`, five runs):
  - it failed with `Function execution timed out (maximum duration: 1s)` after 1000.5–1001.6 ms;
  - SIGKILL to process exit took 1.2–4.1 ms;
  - a new child was ready 34–70 ms after the kill;
  - the next call on the deployment succeeded in 35–73 ms.

  Today (`vm`), the loop never ends. The test runs it in a child process and kills it after 4 s.
- **Allocating loop** (`sb:allocate`, 128 MiB cap, three runs):
  - it failed with `JavaScript execution ran out of memory (maximum memory usage: 128 MB)` after 124–165 ms;
  - `memory.peak` was at or under the cap;
  - the host stayed well under 1 GiB;
  - the next call succeeded in about 39–41 ms.

  Today it would grow the server until the OS kills it, so it was not run.

## 6. Tests and sabotage

**The tests.** They are in `bench/process-sandbox/sandbox.test.ts` and opt in: `SANDBOX_STUDY=1 bun test
bench/process-sandbox`. The `vm` half runs anywhere. The sandbox half needs Linux, root and bwrap. Without
`SANDBOX_STUDY` all 7 tests skip, so the root test run and CI are unaffected.

1. *Today: app code reaches the host's process, secrets, files, network and other processes.* The `escapes`
   action, run in `vm`, must escape on every probe.
2. *Today: a synchronous loop is never interrupted* (DV-208).
3. *Sandbox: every escape is blocked.*
4. *Sandbox: an infinite loop is killed at the user timeout, and the deployment recovers.*
5. *Sandbox: an allocating loop is stopped at the memory cap and reported, and the host survives.* The test checks
   the message, `oom` as the death reason, and `memory.peak` ≤ the cap.
6. *Sandbox: the host refuses ops that a function's kind does not allow,* whatever the child sends.
7. *Sandbox: results match the `vm` executor.* It covers gets, pages, a filter, a patch, an action's nested query
   and mutation, the frozen time, and a thrown error.

All 7 pass on the VPS. On the Mac, the 2 `vm` tests pass and the 5 Linux tests skip.

**The escape probes.** `results/escapes.jsonl` records each probe's outcome. Each line is the attempt and what it
got.

| Probe | vm (today) | process, no sandbox | bwrap + seccomp + cgroup |
|---|---|---|---|
| Real `process` | escaped (the host's pid) | the child's own process | the child's own process (pid 2 in its namespace; holds nothing) |
| Host secret in env | **escaped** | blocked (clean env) | blocked |
| `/proc/<host>/environ` | **escaped** | **escaped** | blocked (ENOENT) |
| Read a host secret file | **escaped** | **escaped** | blocked (ENOENT) |
| Write next to it | **escaped** | **escaped** | blocked |
| TCP to the host's port | **escaped** | **escaped** | blocked |
| Signal the host | **escaped** | **escaped** | blocked (ESRCH) |
| See other processes | **escaped** (105) | **escaped** (106) | blocked (2) |
| Fork bomb (100 bun processes) | **escaped** | **escaped** | blocked (stopped at ~30, `pids.max`) |

**Sabotage.** `SANDBOX_SABOTAGE` drops one layer in `host.ts` (`results/sabotage.txt`, `results/escapes.jsonl`):

| Sabotage | Escape that reappears | Test that fails |
|---|---|---|
| `net` (keeps the network namespace shared) | None. seccomp still refuses `socket(AF_INET)`, which Bun reports as ECONNREFUSED | None (one layer is enough) |
| `seccomp` (no filter) | None. The empty net namespace still holds | None (one layer is enough) |
| `net,seccomp` | TCP to the host | 3 |
| `fs` (binds `/etc` and `/root`) | Reading the secret file (writes still hit EROFS) | 3 |
| `env` (no `--clearenv`, host env passed) | The host secret in env | 3 |
| `cgroup` (child not moved into it) | Fork bomb; no memory cap | 3 and 5 |
| `timeout` (host never arms the timer) | The loop runs until the test's 20 s timeout | 4 |
| `memory` (cap raised to 2 GiB) | `memory.peak` of 2048 MiB | 5 (after `memory.peak ≤ cap` was added: the first version checked only the message, and passed) |

The network has two independent layers, so taking out either one alone keeps it blocked. That is defence in depth,
and the tests show it.

## 7. Pros, cons and the verdict

### 7.1 Pros

- **A real boundary on Linux.** Every escape that works today is blocked: process, env, filesystem, network,
  signals, other processes and fork bombs. The protection comes from well-understood kernel features (namespaces,
  seccomp, cgroups), in addition to whatever the JS engine provides.
- **Real limits.** A loop is killed in 1–4 ms once its budget is spent, and an allocation at the memory cap. The
  host survives both, and the deployment serves again 35–75 ms later. DV-208 goes away, and bunvex gets the memory
  limit it has never had.
- **Cheap at rest.** About 5.5 MiB per idle deployment, roughly 190 per GiB. It is simple to operate: one process
  per deployment, killed and restarted freely.
- **The semantics stay on the host.** Transactions, read sets, OCC, the query cache and the scheduler are
  unchanged. The child is stateless and untrusted.
- **Clean pushes.** Old code dies with its process. That is DV-164's motivation, with no GC dependence.
- **One mechanism for Node actions.** `"use node"` actions could run in the same kind of child, which fixes DV-500.
  An unhandled rejection can then fail the action and exit the child, as Convex's executor does.

### 7.2 Cons

- **Latency per `ctx` op.** It is about 40 µs (pinned) to 240 µs (unpinned on this VPS), against about 12 µs
  in-process. A function making 100 sequential `db.get`s goes from about 1.2 ms to 5–25 ms.
  - Convex pays about a microsecond per syscall in-process.
  - Pinning or spinning recovers most of it.
  - Pages, and code that awaits several reads at once, amortise it.
- **Throughput.** −25 % to −47 % in-process at concurrency 8 to 64 on two vCPUs. −1 % to −15 % over HTTP.
- **Coarser kills.** A timeout or OOM kills the whole deployment process, so its other in-flight calls fail too.
  Convex kills one request. Only a pool of one-request processes would match it.
- **A coarser memory cap.** The cap is per process (runtime included) and not per request heap. Concurrent requests
  share it.
- **Pushes are slower.** About 41 ms against about 3 ms today, plus a cold first call of 6–12 ms.
- **Linux only, with privilege.** It needs bubblewrap, cgroup delegation, and user namespaces allowed. macOS gets a
  partial Seatbelt guard, Windows nothing.
- **More surface to build.** Every `ctx` API needs an op and a host check: storage, search, HTTP actions, streams,
  components, and the size limits. The `AsyncResource` re-entry and user-time accounting must be exact (§4.6).

### 7.3 For self-hosted users

The costs are real and buy little when the operator wrote the code. **Recommendation: C as a mode.**
- `sandbox: "process"` for a cloud, with bwrap, seccomp and cgroups required.
- An optional "isolated" mode for self-hosters who want the limits: real timeout, memory cap, and Node actions
  isolated.
- The `vm` executor stays the default.

### 7.4 Parity effect

| Convex behaviour | Today | With C |
|---|---|---|
| The 1 s timeout terminates a sync loop | Cooperative (DV-208) | **Matches:** the process is killed, with Convex's message |
| The 64 MiB heap limit and its OOM message | None | **Close:** per process, runtime included; the message matches |
| A fresh context per request (DV-165) and per-call component evaluation (DV-492) | Per code version | Unchanged by C alone. A fresh process per request is too slow (~60 ms); a vm context per request *inside* the sandbox could give it, since vm is fine as a non-boundary there (not measured) |
| Old code freed on push (DV-164's reason) | Per-version vm contexts | Matches, more simply (the process exits) |
| Node actions in a separate process; unhandled rejection fails the action (DV-87, DV-500) | In the server's process | **Matches**, if `"use node"` runs in its own child (one action at a time, or exiting on rejection as Convex does) |
| No access to the host from user code | Not true (DV-164) | **Matches** on Linux |
| Isolates never shared across tenants | Not applicable | Matches: one process per deployment |

### 7.5 Verdict

**Viable for a bunvex cloud.** The boundary holds against every probe, sabotage shows each layer catching its
escape, and the limits behave as Convex's do from the outside. The memory cost allows on the order of a hundred
idle deployments per GiB. The cost is per-op latency.
- On a well-tuned host it is 3–4× today's per-op cost, still under 0.1 ms per op.
- On an untuned VM with cross-CPU wakeups it is much more.
- Over HTTP, the cost is mostly hidden.

**Not recommended as the default** for self-hosting.

**Before production, five things:**
1. per-child user-time accounting (§4.6);
2. CPU affinity, or a spin before blocking;
3. the full `ctx` surface, with message size limits;
4. unprivileged operation with a delegated cgroup;
5. a decision on kill granularity (Q3).

## 8. Divergences

This study changes no behaviour, so it records no divergences. If C is built, these become owner decisions
(Q1–Q5).

| # | Divergence | Why | Decision |
|---|---|---|---|
| — | none (exploratory) | | |

## 8b. Additions

None. An isolated execution mode for self-hosters would be an addition (Q2).

## 9. Open questions for the owner

Each question uses the decision format.

**Q1. Should bunvex build option C (a sandboxed process per deployment) for the cloud?**
- **Convex:** V8 isolates in-process, 64 MiB heap, terminate on timeout, a fresh context per request. In the cloud,
  Funrun and Lambda (Firecracker) for Node.
- **bunvex today:** a `vm` context per code version in the server's process, with no boundary (DV-164).
- **With C:** a Bun child per deployment in bubblewrap + seccomp + cgroup, where every `ctx` call is a host op.
- **Same?** Same outside behaviour (errors, limits, isolation). A different mechanism.
- **Why it differs:** "Não dá pra fazer" with isolates: JSC has no isolate API.
- **App impact:** about 40–240 µs per `ctx` op; −1 % to −15 % over HTTP in this test.
- **Recommendation:** yes, as the cloud executor, after the five items in §7.5.

**Q2. C only in the cloud, or also a self-hosted option, or the default?**
- **Convex:** one model everywhere (isolates; the local backend runs Node actions in a local `node`).
- **bunvex:** today, in-process everywhere.
- **Same?** Not today. With C as the default everywhere, it would be the same.
- **Why it differs:** C costs latency and needs Linux privileges: "Não dá pra fazer" on macOS and Windows as a
  boundary.
- **App impact:** none in the default mode. Self-hosters who turn it on get the real limits.
- **Recommendation:** cloud only by default; an opt-in "isolated" mode for Linux self-hosters; `vm` stays the
  default (an addition, to record as AD-NN).

**Q3. Kill granularity: one process per deployment, or a pool of one-request processes?**
- **Convex:** a timeout or OOM kills one request; others continue.
- **bunvex with C, as prototyped:** every in-flight call of the deployment fails with it.
- **Same?** No.
- **Why it differs:** "Ainda não fizemos." A pool per deployment would match, at K × memory.
- **App impact:** a buggy function can fail a tenant's concurrent requests (but never another tenant's).
- **Recommendation:** start with one process per deployment, and add a pool of 2–4 for busy deployments.

**Q4. What does the memory cap measure?**
- **Convex:** 64 MiB of V8 heap per isolate (96 MiB hard).
- **bunvex with C:** a cgroup per process, the Bun runtime included (7–30 MiB of it).
- **Same?** No.
- **Why it differs:** "Não dá pra fazer" exactly. JSC has no per-request heap limit, and Bun ignores Worker
  `resourceLimits`.
- **App impact:** the limit is shared by the deployment's concurrent requests.
- **Recommendation:** a 96 MiB cgroup per process with Convex's message. Revisit with Q3's pool.

**Q5. Should `"use node"` actions move to a child process (fixing DV-87/DV-500) even without the full sandbox?**
- **Convex:** a separate node-executor process (Lambda in the cloud).
- **bunvex:** in the server's Bun.
- **Same?** No.
- **Why it differs:** "Ainda não fizemos." The prototype's host/child split is the mechanism.
- **App impact:** Node actions get isolation from the server, and Convex's unhandled-rejection behaviour.
- **Recommendation:** yes, as the first production use of the prototype's split, behind a flag.

**Q6. Engine for the child: Bun (C), or an embedded QuickJS (D)?**
- **Convex:** V8.
- **bunvex today:** JSC, through Bun.
- **Same?** No in both cases. D would be a different engine from Bun's.
- **Why it differs:** "Não dá pra fazer" with V8 under Bun.
- **App impact:** D changes performance (an interpreter) and language-support details. C keeps JSC.
- **Recommendation:** C. Consider D only if a future workload needs microsecond ops.
