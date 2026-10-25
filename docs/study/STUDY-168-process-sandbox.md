# STUDY-168 — Running app code in a sandboxed process (exploratory)
<!-- index: Running app code in a sandboxed Bun process per deployment ("option C"): Convex's isolates, ops and limits, the threat model, a prototype (host ops over IPC into the real transaction; bubblewrap, seccomp, cgroup v2; Seatbelt on macOS), measurements against today's `vm` executor, escape and limit tests; round 2: the configuration design (an env knob and a flag, fail at start), bubblewrap in Docker (the minimum options and their cost) and a no-privilege Landlock mode, a 12-PR implementation plan, and the first round's fixes measured (user time in the child, a one-call pool, affinity, batching, an unprivileged host) | decided (owner, 2026-10-19: `vm` stays the self-hosted default, a cloud uses C, self-hosters opt in with `BUNVEX_FUNCTION_SANDBOX=process`; every recommendation accepted, AD-44); being built (STUDY-171) -->

- **Status:** decided (owner, 2026-10-19: every recommendation accepted, the knob named `BUNVEX_FUNCTION_SANDBOX`;
  AD-44). Being built as STUDY-171 (PR 1: the seam; PR 2, §7 there: the wire and the child runtime; PR 3, §8:
  queries and mutations over the bridge; PR 4, §11: logs and errors; PR 5, §12: actions; PR 6, §14: HTTP actions; PR 7, §15: components). The prototype and its measurements stay in `bench/process-sandbox/` as the
  reference: no default code path reaches them, and their tests run only with `SANDBOX_STUDY=1`.
- **Convex source read:** commit `d8bdde0` of get-convex/convex-backend, the reference commit
  ([upstream.md](../parity/upstream.md)). The first round read `4577b903`; every citation was re-checked at
  `d8bdde0` in round 2, and the line numbers below are `d8bdde0`'s.
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

**Round 2** (2026-10-19). The owner agreed with the verdict: self-hosted keeps the in-process `vm` executor by
default, a future cloud runs app code in C, and self-hosters may opt in. Round 2 adds what is needed to judge the
effort and how the mode is turned on:
- **§10, enabling it.** One env knob, `BUNVEX_FUNCTION_SANDBOX=vm|process` (the name is the owner's call), with a
  matching `bunvex-local-backend` flag. The existing timeout knobs keep their Convex names, and the memory cap reuses
  Convex's heap knobs. When the host cannot sandbox, the backend fails at start (recommended), with no silent
  fallback.
- **§11, Docker.** bubblewrap runs in the self-hosted image with four `--security-opt`s and no added capability, or
  with `--privileged`. A second mode needs **no extra privileges at all**: a per-deployment uid, Landlock, seccomp and
  rlimits. It blocked every probe in a default `docker run`, but it has no memory cap of its own. Per-call cost in
  Docker is the same as on the host.
- **§12, the plan.** 12 PRs, about 7,000 lines with tests. The engine, transactions, OCC, sync, persistence, the
  client and app code do not change.
- **§13, the first round's fixes, measured:**
  - user time is now counted in the child, so a 10 000-insert mutation fits in 1 s;
  - a pool of one-call processes kills only the stuck call (0 of 16 neighbours failed, against 15);
  - pinning host and child to one CPU makes 10 `db.get`s 3.4× faster;
  - batching makes 10 parallel `db.get`s 5.6× faster;
  - the host runs **unprivileged** on Ubuntu 24.04, with the userns restriction kept on.
- **§14, the gaps.** The cost of moving bytes over the bridge, CPU fairness between two deployments, and an
  unmodified example app (`examples/pagination`) over HTTP: −27 % at concurrency 8, −6 % at 32.

## In plain words

Today, an app's functions run inside the bunvex server's own process. Node's `vm` module gives them a separate set
of globals, but not a wall. An app can reach the server's real `process`, read its secrets, open its files and
connect to its ports (§6). For an operator running their own code, that is acceptable. A cloud running strangers'
code needs a wall.

Option C moves the app's code into a **separate process**, and the operating system builds the wall around that
process. The server keeps the data. Every time the app asks for something (`ctx.db.get`, an insert, `fetch`), the
child sends a small message to the server, which does the work and answers. The Linux tools that build the wall:

- **Namespaces** give a process its own private view of one kind of thing. In a new *mount* namespace it sees only
  the files it is handed. In a *pid* namespace it sees only its own processes. In a *network* namespace it has no
  network. In a *user* namespace it is "root" of nothing real.
- **bubblewrap** (`bwrap`) is a small, widely used program (Flatpak's sandbox) that starts a program inside new
  namespaces, with a hand-picked, read-only set of files.
- **seccomp** is a kernel filter on system calls, the requests a program makes to the kernel. The filter refuses the
  dangerous ones, such as tracing another process, mounting, or opening an IP socket.
- **cgroups** (control groups) are the kernel's resource meters. A cgroup caps how much memory, CPU and how many
  processes the processes inside it may use. Over the memory cap, the kernel kills the process instead of letting
  the machine run out.
- **Landlock** (§11) restricts which files and TCP ports a process may use. Any program may apply it to itself, so
  it needs no privilege, but it shows less than a mount namespace hides.
- **AppArmor** is Ubuntu's security layer. Since Ubuntu 24.04 it refuses user namespaces to programs without a
  profile that allows them (§13.5).

In short, a stuck or hostile function gets killed, and it cannot see or touch anything but its own messages to the
server. The costs are a few tens of microseconds per message, a few MiB of memory per deployment, and the setup
work in §10 and §11.

**Reading guide.** §1–§9 are the first round (Convex's model, the design, the measurements, the verdict and the
owner questions, which round 2 updates). §10–§14 are round 2.

---

## 1. How Convex does it

### 1.1 Isolates and the ops-only bridge

- **The engine.** Convex embeds V8 through `deno_core::v8`, using Convex's own fork of rusty_v8
  (`Cargo.toml:73,283`). It drives raw V8 without deno's `JsRuntime`. `initialize_v8()` runs once per process
  (`crates/isolate/src/client.rs:469-537`). It starts the platform with `V8_THREADS` threads and sets these flags:
  - `--disallow-code-generation-from-strings`, which turns off `eval` and `new Function` (`client.rs:510`);
  - `--stack-size=2048`;
  - `--no-wasm-async-compilation` (`client.rs:505-518`). `ISOLATE_V8_FLAGS` adds more, read with a plain
    `env::var` (`client.rs:519-527`).
- **The isolate.** `Isolate::new` (`crates/isolate/src/isolate.rs:168-237`) builds it through
  `udf_runtime::create_isolate_with_udf_runtime` (`crates/isolate/src/udf_runtime.rs:43-59`), with these settings:
  - **Heap limits:** `heap_limits(INITIAL_HEAP_SIZE, ISOLATE_MAX_USER_HEAP_SIZE + ISOLATE_MAX_HEAP_EXTRA_SIZE)`.
    That is 64 MiB of user heap plus 32 MiB for state kept between contexts (`crates/common/src/knobs.rs:1152-1159`).
  - **ArrayBuffers:** a custom allocator caps their total at 64 MiB
    (`crates/isolate/src/array_buffer_allocator.rs:102-117`, `knobs.rs:1161-1163`).
  - **Modules:** `import.meta` and dynamic `import()` throw (`isolate.rs:188,192`).
  - **Other:** `Atomics.wait` is off (`isolate.rs:195`), and microtasks run explicitly (`isolate.rs:197`).
- **Out of memory.** A near-heap-limit callback (`isolate.rs:208-211`, `403-429`) terminates the isolate with
  `OutOfMemory`. It then raises the limit so that V8 does not abort the process. The app sees
  `JavaScript execution ran out of memory (maximum memory usage: 64 MB)` (`crates/isolate/src/termination.rs:346-347`;
  the "64 MB" is part of the string, not taken from the knob).
- **The bridge.** Each fresh context gets four native functions on `globalThis.Convex`: `syscall`, `asyncSyscall`,
  `op` and `asyncOp` (`crates/isolate/src/request_scope.rs:228-298`).
  - Database calls are JSON-in/JSON-out syscalls such as `1.0/get`, `1.0/insert`, `1.0/queryPage` and `1.0/runUdf`
    (`crates/isolate/src/environment/udf/syscall.rs:133-141`, `async_syscall.rs:255-257,748-791`).
  - The ops cover randomness, time, crypto, console and `fetch` (`crates/isolate/src/ops/mod.rs:323-489`).
  - Any error that is not deterministic terminates the isolate. The app then sees "Convex encountered an internal
    error" (`request_scope.rs:348-405`, `strings.rs:74`).
- **No host objects.** JS gets values only, as JSON or V8 values built from them. It never holds a reference into
  the host. `process` is `{ env }`, and each read of `env` is an op (`npm-packages/udf-runtime/src/00_misc.ts:41-60`).
  There is no `require`, filesystem or socket.

### 1.2 The per-request context, the pool and the limits

- **A fresh context per request.**
  - `IsolateWorker::service_requests` (`client.rs:1523-1621`) keeps one isolate. For each request it hands out a
    fresh `v8::Context` from the startup snapshot (`crates/isolate/src/context_cache.rs:83-114`,
    `udf_runtime.rs:80-196`).
  - A module that exports `experimental_reuseContext` keeps its context, but only after successful runs, and only
    while its import-time reads still hold (`environment/udf/mod.rs:777-908`, `context_cache.rs:116-176`).
- **No reuse across clients.** An isolate is never shared between clients: "We don't allow an isolate to be reused
  across clients for security isolation." (`client.rs:1577-1587`).
- **Recycling.** An isolate is recycled when any of these happens (`client.rs:1660-1689`, `isolate.rs:280-321`; the idle wait is at `client.rs:1566`):
  - a termination (timeout, out of memory, system error);
  - free heap drops below 64 MiB;
  - a context leaks;
  - `ISOLATE_MAX_LIFETIME_SECONDS` (3600) passes (`knobs.rs:1036-1037`);
  - `ISOLATE_IDLE_TIMEOUT_SECONDS` (600) of idle time passes (`knobs.rs:1032-1033`).
- **The pool.** The pool knobs are `MAX_ISOLATE_WORKERS` (300) and `V8_THREADS` (the number of cores)
  (`knobs.rs:1004-1006`, `1023-1024`). The CoDel queue holds 2000 (`knobs.rs:986-992`). One client gets at most 50 %
  of the workers (`FUNRUN_SCHEDULER_MAX_PERCENT_PER_CLIENT`, `knobs.rs:1412-1415`; `client.rs:1190-1211`). The local
  backend uses 100 %: it is single-tenant (`crates/function_runner/src/in_process_function_runner.rs:143-144`).
- **Timeouts.** A query or mutation has 1 s of user time (`DATABASE_UDF_USER_TIMEOUT_SECONDS`, `knobs.rs:967-969`)
  and 15 s of system time (`knobs.rs:979-980`). A V8 action has 1800 s and a Node action 600 s
  (`knobs.rs:208-218`).
  - **Enforcement.** An `isolate_timeout` task (`crates/isolate/src/timeout.rs:180-206,341-361`) extends the
    deadline by the time spent paused in async syscalls (`timeout.rs:101-112`). When the deadline passes, it calls
    `v8::IsolateHandle::terminate_execution()` (`termination.rs:89-99,169-187`).
  - **Messages.** The app sees `Function execution timed out (maximum duration: 1s)` (`termination.rs:349-351`).
    Too much syscall time gives `Your request timed out performing too many system operations.`
    (`timeout.rs:46-47`).
- **Determinism.** `Math.random` comes from a ChaCha12 PRNG seeded per execution
  (`crates/isolate/src/environment/udf/phase.rs:449-472`, seed drawn in `crates/function_runner/src/server.rs:381-385`).
  `Date.now()` is frozen at the transaction's timestamp (`crates/isolate/src/ops/time.rs:34-43`).
- **Transaction state.** The read set, the writes and OCC stay in Rust, in `UdfPhase { tx }` (`phase.rs:86-121`;
  `crates/database/src/transaction.rs:173,190-191`). JS only ever sees syscall results.

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
  Funrun. It is not in the open-source tree. The knob `UDF_USE_FUNRUN` (default true) is documented as the choice
  between it and `InProcessFunctionRunner` (`knobs.rs:1320-1322`), but no open-source code reads it: the local
  backend always builds an `InProcessFunctionRunner` (`crates/local_backend/src/lib.rs:232-245`;
  `in_process_function_runner.rs:112-154`). The choice lives in the closed cloud code.
- **Lambda.** Node actions run on AWS Lambda, which isolates with Firecracker VMs
  (`npm-packages/node-executor/src/aws_lambda.ts:18-55`, line 27). The Lambda memory limits are 512 MiB static and
  4096 MiB dynamic (`knobs.rs:1518-1533`). Credentials are protected by IAM policies (`executor.ts:96-100`).

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
   one isolate, and so one request. Only a pool of one-request processes (§4.2) avoids this. Round 2 built and
   measured that pool (§13.2).
2. **The cgroup cap covers the whole process.** The Bun runtime takes about 7–30 MiB of it (§5.5), so "64 MB of
   heap" maps to roughly a 96 MiB cgroup. Convex's own hard limit, including the extra 32 MiB, is 96 MiB.

**A finding to fix: user time also counts the IPC.** The engine's cooperative timer counts the time a stand-in
waits for the child as user time, IPC transit included. A mutation of 10 000 inserts fits in 1 s in-process, but
took over 1 s in the sandbox, and the bench had to seed in batches of 1000. The real executor must take user time
from the child's own accounting, its JS time excluding op waits, and treat round trips as paused time. **Fixed in
round 2** (§13.1).

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
restricts unprivileged user namespaces by default. Round 2 ran the host unprivileged with a delegated cgroup and an
AppArmor profile for a private copy of bwrap, with the restriction left on (§13.5).

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
`transport-bench.ts`, with the raw JSON lines in `bench/process-sandbox/results/`. Round 2's scripts:
- `fixes-bench.ts <usertime|pool|affinity|batch|neighbour>`, `example-workload.ts`, `bytes-bench.ts`,
  `container-rtt.ts` and `run-round2.sh`;
- `unprivileged.sh`;
- `docker/` (`matrix.sh`, `run-tests.sh`, `run-probes.sh`, `bench-docker.sh`, the image and both profiles);
- `summarize.py`, which turns `bench.ts` lines into tables.

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

**Round 2** adds three tests (`fixes (…)`). They run on the Mac with a plain child, and on Linux in the sandbox:

8. *User time is the child's own JS time:* 10 000 sequential inserts fit in the 1 s budget, and a loop is still
   killed.
9. *A pool of one-call processes:* a timeout fails only the guilty call, and six concurrent calls succeed.
10. *Batched ops give the same results* as the `vm` executor.

**Round 2's sabotage** undoes each fix (`results/sabotage-round2.txt`, on the VPS):

| Sabotage | Test that fails |
|---|---|
| `accounting` (host-measured user time, as in round 1) | 8: the 10 000 inserts time out at 1 s |
| `pool` (no pool) | 9: the neighbours of the stuck call fail with it |
| `slack` (a backstop that fires after 60 s) | 8 and 9: the loop is no longer killed |

On the Mac, `accounting` alone does not fail test 8. The Mac's round trip (about 30 µs) keeps 10 000 inserts under
1 s even with the IPC counted, so that sabotage needs the VPS.

`SANDBOX_MODE=confine` runs the sandbox half in the no-namespace mode (§11.3). There its memory test is skipped,
because that mode has no cgroup.

Round 2 also fixed two probes that gave false positives in Docker. The host there is pid 7, and inside the sandbox's
own pid namespace that number can belong to the sandbox's init or to one of the child's own threads.
- The environ probe now counts an escape only when it finds the host's `SANDBOX_STUDY=` variable.
- The signal probe first checks that the pid is not one of the child's own threads.

It added one probe, `hostCmdline`: any uid may read another process's `/proc/<pid>/cmdline`, and the Docker image
passes `--instance-secret` on its command line (`docker/run_backend.sh`).

Results, all on the VPS (`results/tests-host.txt`, `results/docker-tests.txt`, `results/unprivileged.txt`):
- the host as root: 10 of 10 pass;
- the host unprivileged: 10 of 10 pass;
- Docker with bwrap's options (§11.2): 10 of 10 pass;
- Docker in the confine mode, with default options: 9 pass and 1 skips.

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

**Before production, five things** (round 2's status in brackets):
1. per-child user-time accounting (§4.6) [prototyped and measured, §13.1];
2. CPU affinity, or a spin before blocking [affinity measured, §13.4; spinning not tried];
3. the full `ctx` surface, with message size limits [planned, §12];
4. unprivileged operation with a delegated cgroup [prototyped, §13.5];
5. a decision on kill granularity (Q3) [the pool is prototyped and measured, §13.2; still the owner's decision].

## 8. Divergences

This study changes no behaviour, so it records no divergences. If C is built, these become owner decisions
(Q1–Q5).

| # | Divergence | Why | Decision |
|---|---|---|---|
| — | none (exploratory) | | |

## 8b. Additions

None decided. Shipping C as a mode is an addition, AD-NN, to be numbered when it is decided. Convex has no executor
choice at all: the local backend always runs functions in-process (§10.1). See Q2 and Q7.

## 9. Open questions for the owner

**Decided (owner, 2026-10-19): every recommendation below is accepted, Windows is out of scope, and the knob is
`BUNVEX_FUNCTION_SANDBOX` (Q7). Q11 is built in STUDY-170; the implementation is STUDY-171 (AD-44).**

Each question uses the decision format. The owner has already agreed that the self-hosted default stays `vm`, that
a cloud runs app code in C, and that self-hosters may opt in. Q1 and Q2 record that. Q7 to Q11 are new in round 2.

**Q1. Should bunvex build option C (a sandboxed process per deployment) for the cloud?** *Agreed by the owner
(2026-10-19).*
- **Convex:** V8 isolates in-process, a 64 MiB heap, termination on timeout, a fresh context per request. In the
  cloud, Funrun runs functions, and Lambda (Firecracker) runs Node actions.
- **bunvex today:** a `vm` context per code version in the server's process, with no boundary (DV-164).
- **With C:** a Bun child per deployment in bubblewrap, seccomp and a cgroup. Every `ctx` call is a host op.
- **Same?** The same outside behaviour (errors, limits, isolation), by a different mechanism.
- **Why it differs:** "Não dá pra fazer" with isolates: JSC has no isolate API.
- **App impact:**
  - about 40–240 µs per `ctx` op;
  - −1 % to −15 % over HTTP on the bench workload;
  - −6 % to −27 % on `examples/pagination` (§14.3).
- **Recommendation:** yes, as the cloud executor, built in the order of §12.

**Q2. C only in the cloud, or also as a self-hosted option?** *Agreed: `vm` stays the self-hosted default;
self-hosters may opt in.*
- **Convex:** one model everywhere: isolates in-process. The local backend runs Node actions in a local `node`.
- **bunvex:** today, in-process everywhere. With this, `vm` by default and C on request.
- **Same?** The default is the same as Convex's in-process model. The option is an addition.
- **Why it differs:** C costs latency and needs Linux privileges, which is "Não dá pra fazer" as a boundary on
  macOS and Windows.
- **App impact:** none in the default mode. Self-hosters who turn it on get the real limits and the boundary.
- **Recommendation:** ship the option as AD-NN, configured as Q7 proposes.

**Q3. Kill granularity: one process per deployment, or a pool of one-request processes?** (Round 2 measured it,
§13.2.)
- **Convex:** a timeout or an OOM kills one request. The others continue.
- **bunvex with C:**
  - one process per deployment: a timeout failed **15 of 16** concurrent calls;
  - a pool of 2 or 4 one-call processes failed **none**;
  - a pool of 1 also failed none, but queued everything behind the stuck call (p99 1.09 s).
  - The cost: each pool process adds about 5–6 MiB idle and 13 MiB busy (cgroup memory). One-call processes also
    cap concurrency at the pool size: −30 % at concurrency 32 with a pool of 2 (§14.3).
- **Same?** Only with the pool.
- **Why it differs:** "Ainda não fizemos." A pool matches Convex.
- **App impact:** without the pool, a buggy function can fail a tenant's concurrent requests, but never another
  tenant's.
- **Recommendation:**
  - an elastic pool per deployment, one call per process, sized to concurrency: start with 1 or 2 warm processes,
    grow to a cap (16), and shrink when idle;
  - one process per deployment that runs concurrent calls stays available as the low-memory setting, for idle or
    tiny tenants.

**Q4. What does the memory cap measure?**
- **Convex:** 64 MiB of V8 heap per isolate, 96 MiB hard.
- **bunvex with C:** a cgroup per process, the Bun runtime included (7–30 MiB of it). With Q3's pool, a process runs
  one call, so the cap is per call, as Convex's is.
- **Same?** Close with the pool. Not the same without it.
- **Why it differs:** "Não dá pra fazer" exactly. JSC has no per-request heap limit, and Bun ignores Worker
  `resourceLimits`.
- **App impact:** without the pool, the limit is shared by the deployment's concurrent requests.
- **Recommendation:**
  - with the pool, a cgroup `memory.max` of `ISOLATE_MAX_USER_HEAP_SIZE + ISOLATE_MAX_HEAP_EXTRA_SIZE` (96 MiB by
    Convex's defaults), with Convex's message (§10.3);
  - in the no-namespace Docker mode (§11.3) there is no per-call cap: the backend container's own `--memory` is the
    only one.

**Q5. Should `"use node"` actions move to a child process (fixing DV-87/DV-500) even without the full sandbox?**
- **Convex:** a separate node-executor process (Lambda in the cloud).
- **bunvex:** in the server's Bun.
- **Same?** No.
- **Why it differs:** "Ainda não fizemos." The prototype's host/child split is the mechanism.
- **App impact:** Node actions get isolation from the server, and Convex's unhandled-rejection behaviour.
- **Recommendation:** yes, as PR 10 of §12. It can ship before the full sandbox, behind the same knob.

**Q6. Engine for the child: Bun (C), or an embedded QuickJS (D)?**
- **Convex:** V8.
- **bunvex today:** JSC, through Bun.
- **Same?** No in either case. D would also differ from Bun's engine.
- **Why it differs:** "Não dá pra fazer" with V8 under Bun.
- **App impact:** D changes performance (an interpreter) and language-support details. C keeps JSC.
- **Recommendation:** C. Consider D only if a future workload needs microsecond ops.

**Q7. Shipping the mode for self-hosters (AD-NN): how is it turned on, and what is it called?** (§10)
- **Convex:** nothing to turn on. The local backend always builds an in-process function runner
  (`crates/local_backend/src/lib.rs:232-245`). The documented `UDF_USE_FUNRUN` knob is read by no open-source code.
- **bunvex:** proposed:
  - an env knob `BUNVEX_FUNCTION_SANDBOX=vm|process` (default `vm`), with a matching `bunvex-local-backend` flag
    `--function-sandbox <vm|process>`. The flag wins over the env, as `--deny-addresses` does over
    `BUNVEX_DENY_ADDRESSES`;
  - a second knob, `BUNVEX_FUNCTION_SANDBOX_ISOLATION=auto|namespaces|landlock|none`, picks the layers;
  - limits under Convex's names (§10.3).
- **Same?** Not applicable (an addition). The default (`vm`) behaves as today.
- **Why it differs:** an addition. Convex has no self-hosted isolation choice.
- **App impact:** none unless turned on. When on: the real limits and §5's per-op cost.
- **Recommendation:** the env knob plus the flag. **The knob's name is the owner's call.** `BUNVEX_FUNCTION_SANDBOX`
  follows bunvex's own knobs (`BUNVEX_DENY_ADDRESSES`, `BUNVEX_HTTP_PROXY`). Convex-named knobs are kept for the
  things Convex has.

**Q8. When the host cannot sandbox: fail at start, or fall back with a warning?** (§10.4)
- **Convex:** not applicable. Its nearest analogues are explicit opt-outs that Convex makes the operator name:
  `--do-not-require-ssl`, and the start-up warning for an unscreened `fetch`.
- **bunvex:** proposed: **fail at start**, naming what is missing and how to fix it. A downgrade is only ever
  explicit, through `BUNVEX_FUNCTION_SANDBOX_ISOLATION=landlock` or `=none`.
- **Same?** Not applicable.
- **Why it differs:** an addition.
- **App impact:** an operator who asked for isolation never silently runs without it.
- **Recommendation:** fail at start, after a start-up self-test that spawns one sandboxed probe (about 60 ms).

**Q9. In the Docker image: which isolation does `auto` pick, and which `docker run` options are documented?** (§11)
- **Convex:** its image runs functions in-process. It needs no options and documents none.
- **bunvex:** proposed:
  - in a default `docker run`, `auto` picks `landlock`: per-deployment uid, Landlock, seccomp and rlimits, with no
    extra privilege (§11.3);
  - the compose file documents the four options that enable `namespaces` (§11.2);
  - `--privileged` is never recommended.
- **Same?** Not applicable.
- **Why it differs:** an addition.
- **App impact:**
  - **`landlock`** blocks every probe, but the no-namespace mode has no per-call memory cap.
  - **`namespaces`** gives everything, but needs the operator to load an AppArmor profile on the host.
- **Recommendation:** as proposed. Name the trade-off in the self-hosting docs.

**Q10. Does `bunvex dev` (the local backend the CLI starts) ever use C?** (§10.6)
- **Convex:** `npx convex dev` runs the same in-process local backend.
- **bunvex:** proposed: no by default, and no CLI flag in v1. The knob, set in the developer's environment, reaches
  the backend that `bunvex dev` spawns (it inherits the environment). A Linux developer can reproduce the cloud's
  limits that way.
- **Same?** Yes by default.
- **Why it differs:** not applicable by default. The opt-in is "Não dá pra fazer" as a boundary on macOS and
  Windows: there `process` runs with `none` isolation, which is only useful to reproduce timing and the timeout.
- **App impact:** none by default. Pushes stay about 3 ms instead of about 41 ms (§4.5).
- **Recommendation:** as proposed.

**Q11. Should the Docker image keep `--instance-secret` on the backend's command line?** (A finding of §6 and §11.3)
- **Convex:** its `run_backend.sh` passes `--instance-secret` as a flag
  (`self-hosted/docker-build/run_backend.sh:58-71`), as bunvex's does.
- **bunvex:** the same, today.
- **Same?** Yes.
- **Why it matters:** any process of any uid in the container can read `/proc/<pid>/cmdline`. In `vm` mode, app code
  can read it anyway (it is in-process). In C mode, the namespaces mode hides it, and so does the no-namespace mode
  (Landlock), but a mode without both would leak it. The probe `hostCmdline` shows it.
- **App impact:** none on apps. A defence-in-depth question.
- **Recommendation:** when C ships, pass the secret through the environment or a file
  (`INSTANCE_SECRET` / `--instance-secret-file`), not argv. Asking because it changes the entrypoint that mirrors
  Convex's.

## 10. Enabling it (configuration design)

### 10.1 How bunvex and Convex read knobs today

- **Convex.** Every knob is a `LazyLock` over `env_config(name, default)` (`crates/cmd_util/src/env.rs:23-48`):
  - unset gives the default;
  - a bad value logs a warning and gives the default;
  - an override logs "Overriding … from environment".

  `knobs.rs:2-3,11-12` says that, locally, every knob is an environment variable (in Convex Cloud they come from
  Consul). `DATABASE_UDF_USER_TIMEOUT_SECONDS` is at `knobs.rs:967-969`, and `ISOLATE_MAX_USER_HEAP_SIZE` (bytes)
  is at `knobs.rs:1152-1154`.

  The local backend's flags (`crates/local_backend/src/config.rs:27-150`, clap) are a separate channel. Only
  `--disable-beacon` also reads the env (`config.rs:123`). No flag sets a limit, and none chooses the function
  runner or the Node executor (`lib.rs:206-207,232-245`).
- **Convex's Docker image.**
  - `self-hosted/docker/docker-compose.yml:12-47` passes a fixed list of variables through.
    `self-hosted/advanced/knobs.md:3-9` tells operators to add any `knobs.rs` variable there.
  - `run_backend.sh:58-71` turns a few variables into flags. Every other variable reaches the binary unchanged.
- **bunvex mirrors this.**
  - `packages/core/src/knobs.ts` (`knob`, `boolKnob`, `secondsKnob`) has the same fallback and "Overriding"
    logging.
  - The limits are read on the `Functions` instance (`functions.ts:1854-1859`): `DATABASE_UDF_USER_TIMEOUT_SECONDS`,
    `DATABASE_UDF_SYSTEM_TIMEOUT_SECONDS`, `V8_ACTION_USER_TIMEOUT_SECS` and `NODE_ACTION_USER_TIMEOUT_SECS`.
  - bunvex's own string-valued settings are an env variable plus a flag, parsed strictly. An example is
    `BUNVEX_DENY_ADDRESSES` / `--deny-addresses` (`address-screen.ts:32`; `local-backend.ts`). A bad value is an
    error at start.
  - `docker/docker-compose.yml:19-46` is a pass-through list like Convex's, and `docker/run_backend.sh` maps a few
    variables to flags.

### 10.2 The proposal

| Setting | Env (read once at start) | Flag (`bunvex-local-backend`) | Values, default |
|---|---|---|---|
| Executor | `BUNVEX_FUNCTION_SANDBOX` | `--function-sandbox` | `vm` (default), `process` |
| Isolation layers (`process` only) | `BUNVEX_FUNCTION_SANDBOX_ISOLATION` | `--function-sandbox-isolation` | `auto` (default), `namespaces`, `landlock`, `none` |
| Processes per deployment | `BUNVEX_FUNCTION_SANDBOX_POOL_MAX` | — | 16 (Q3's elastic pool); 0 = one shared process |
| CPU per deployment | `BUNVEX_FUNCTION_SANDBOX_CPUS` | — | unset = no `cpu.max` |
| Processes and threads per child | `BUNVEX_FUNCTION_SANDBOX_PIDS_MAX` | — | 64 |
| cgroup subtree | `BUNVEX_FUNCTION_SANDBOX_CGROUP` | — | `auto`: `sandbox/` under the backend's own cgroup |

- **The executor knob.** It is parsed as `addressScreen` parses its value: a value outside the list is an error at
  start, not a fallback. A security setting should not silently become the default.
- **Isolation values:**
  - `auto` picks `namespaces` when a self-test bwrap starts, else `landlock` when Landlock is available, else
    fails. It logs which one it picked, and that `landlock` has no per-call memory cap. A cloud sets `namespaces`
    explicitly;
  - `none` is a plain child process: macOS, Windows, and debugging only. It is never a boundary, and the start-up
    log says so.
- **Precedence:** flag, then env, then default. The flag exists because the local backend's other security switches
  are flags (`--do-not-require-ssl`, `--redact-logs-to-client`, `--deny-addresses`). The env exists because the
  Docker image and `bunvex dev` pass env straight through.
- **Docker.** One line each in `docker/docker-compose.yml`'s pass-through list (`BUNVEX_FUNCTION_SANDBOX`,
  `BUNVEX_FUNCTION_SANDBOX_ISOLATION`). `run_backend.sh` does not change, because the variable reaches the binary.

### 10.3 Limits: the timeout and memory knobs

| Limit | Knob (unchanged, Convex's name) | `vm` today | `process` |
|---|---|---|---|
| Query/mutation user time | `DATABASE_UDF_USER_TIMEOUT_SECONDS` (1) | checked at each store call (DV-208) | child-reported JS time; the process is killed at the budget + 50 ms of slack (§13.1) |
| Query/mutation system time | `DATABASE_UDF_SYSTEM_TIMEOUT_SECONDS` (15) | as Convex | the same, with IPC waits counted here |
| Action user time | `V8_ACTION_USER_TIMEOUT_SECS` (1800), `NODE_ACTION_USER_TIMEOUT_SECS` (600) | a cut-off (STUDY-77) | the cut-off, then a kill of the process if it ignores it |
| Memory | `ISOLATE_MAX_USER_HEAP_SIZE` (64 MiB) + `ISOLATE_MAX_HEAP_EXTRA_SIZE` (32 MiB) | none | cgroup `memory.max` = their sum per process; `memory.swap.max` = 0; Convex's message |

- **Reusing Convex's heap knobs** keeps one name for one meaning. They are bytes, as in Convex
  (`knobs.rs:1152-1159`).
- **What the message says.** Convex's message hard-codes "64 MB" (`termination.rs:346-347`). bunvex can print the
  configured size and keep Convex's text at the default.
- **Under Q3's pool,** the cap is per call. With one shared process, it is per deployment.
- **The no-namespace Docker mode** (§11.3) has no per-process cgroup. Its only cap is the container's `--memory`,
  and it logs that at start.
- **RLIMIT_DATA is not a cap.** It was tried as a cgroup-free cap. Bun does not start under 512 MiB of data limit
  (it reserves its heap's address space at start). Above that, an allocation fails with a *catchable*
  `RangeError: Out of memory`, which the host cannot see.

### 10.4 When the host cannot sandbox

Each `isolation` value checks what it needs at start, with one sandboxed probe child (about 60 ms):

| What fails | Message points at |
|---|---|
| No `bwrap`, or user namespaces refused | the AppArmor profile (§13.5), or Docker's options (§11.2), or `…_ISOLATION=landlock` |
| cgroup not writable | systemd `Delegate=yes`, or Docker's `writable-cgroups=true` |
| Landlock missing (kernel < 5.13, or ABI < 4 for the TCP rules) | `…_ISOLATION=namespaces` |
| Not Linux | `…_ISOLATION=none`, with the warning that it is not a boundary |

**Recommendation: fail at start.** A fallback with a warning would turn a security setting into a log line nobody
reads. The operator asked for isolation, and a downgrade must be the operator's own explicit setting. `auto` is that
setting's polite form: it only ever chooses between the two real boundaries.

### 10.5 macOS and Windows

- **macOS:**
  - `process` with `none` runs the same host/child code, which is good for timing and the real timeout;
  - an optional Seatbelt guard (`sandbox-exec`, §4.8) blocks the home directory, the network and spawning, but not
    signals, and it sets no memory cap;
  - neither is a boundary. `auto` fails on macOS, as §10.4 says.
- **Windows:** `process` with `none` only, and untested: nothing in this study ran on Windows. There is no sandbox, and AppContainer or Job Objects would need native code.
  "Não dá pra fazer" without native code, and not worth it for a dev platform.

### 10.6 `bunvex dev` and the local backend

- `bunvex dev` starts the local backend binary with fixed flags and no `env:` option, so the backend inherits the
  CLI's environment (`packages/cli/src/local-deployment.ts:285,346-361`). The env knob reaches the backend with no
  change to the CLI. A flag on `bunvex dev` would need plumbing there, and Convex's CLI has none.
- **Default: the dev loop never uses C.**
  - Pushes would go from about 3 ms to about 41 ms (§4.5), plus 6–12 ms for the first call.
  - On a laptop, the operator is the author: there is no boundary to buy.
  - macOS, the common dev platform, cannot sandbox anyway.
- **Opt-in:** `BUNVEX_FUNCTION_SANDBOX=process bunvex dev` on Linux reproduces the cloud's limits (a real timeout,
  a real memory cap) before deploying. Worth one line in the docs.

## 11. Docker

bunvex's self-hosted image is `docker/Dockerfile`: a `bun build --compile` binary on `debian:bookworm-slim`. Round 2
tested on the VPS, with Docker 29.1.3, Ubuntu 24.04, kernel 6.8, and `kernel.apparmor_restrict_unprivileged_userns=1`
(the default). Scripts are in `bench/process-sandbox/docker/`. Results are in `results/docker-matrix.txt`,
`results/docker-tests.txt` and `results/bench-docker.jsonl`.

### 11.1 What blocks bubblewrap in a container

`docker/matrix.sh` runs `bwrap --unshare-all … id` with each option:

| `docker run` options | Result |
|---|---|
| none (the defaults) | "No permissions to create new namespace": Docker's seccomp profile allows `clone`/`unshare` with namespace flags only with `CAP_SYS_ADMIN` |
| `seccomp=unconfined` | "Failed to make / slave": AppArmor's `docker-default` has `deny mount` |
| `apparmor=unconfined` | the seccomp refusal again |
| both unconfined | "loopback: Failed RTM_NEWADDR": unconfined, the process falls under Ubuntu's `unprivileged_userns` profile, which strips capabilities in the new namespace |
| `--cap-add SYS_ADMIN` | "Failed to make / slave" (AppArmor) |
| `--cap-add SYS_ADMIN`, `apparmor=unconfined` | "pivot_root: Operation not permitted" (not in Docker's seccomp allow list) |
| `--privileged` | works |
| bwrap's seccomp profile + `bunvex-sandbox` AppArmor profile | "Can't mount proc": the kernel refuses a new `/proc` while Docker's masked paths cover parts of the old one |
| … without `/proc` in the sandbox | starts, but Bun aborts at start: it reads `/proc/self/maps` (JSC's stack bounds) |
| … + `systempaths=unconfined` | **works** |
| cgroup writes, default | `/sys/fs/cgroup` is mounted read-only |
| cgroup writes, `writable-cgroups=true` | **writable** (also needed: move the container's processes to a leaf `init` first, cgroup v2's no-internal-process rule, as `host.ts` `enableControllers` does) |

### 11.2 The minimum options for the namespaces mode, and what each costs

```
docker run \
  --security-opt seccomp=seccomp-bwrap.json \      # Docker's default profile + clone/unshare/setns/mount/umount2/pivot_root/sethostname
  --security-opt apparmor=bunvex-sandbox \         # docker-default without `deny mount`, plus `mount, pivot_root, userns`
  --security-opt systempaths=unconfined \          # no masked /proc and /sys paths (so bwrap can mount a fresh /proc)
  --security-opt writable-cgroups=true \           # the container's own cgroup subtree, writable
  …
```

No capability is added, and the container's processes keep Docker's default capability set. With these options,
all 10 tests pass inside the container (`results/docker-tests.txt`).

What each option costs the **host**:

| Option | What the container's processes gain | Cost |
|---|---|---|
| seccomp + namespace syscalls | creating user, mount, pid and net namespaces, and mounting inside them | the kernel's user-namespace code becomes reachable to the backend's processes. Many recent kernel privilege escalations needed an unprivileged user namespace, which is why Ubuntu restricts them. The sandboxed child itself cannot use these calls: bwrap's own seccomp filter refuses them |
| AppArmor `bunvex-sandbox` | `mount`, `pivot_root`, `userns` | the profile keeps docker-default's denials on `/proc/sys`, `/proc/sysrq-trigger`, `/proc/kcore` and `/sys` writes, so mounts happen only in new namespaces. The operator must load it on the host (`apparmor_parser -r`): it is a host change |
| `systempaths=unconfined` | the unmasked `/proc/kcore`, `/proc/keys`, `/proc/timer_list`, `/sys/firmware`, … | information leaks to the backend process (which runs no app code in this mode). The AppArmor profile still denies the dangerous writes and `kcore`. Combined with running the backend as a non-root `--user`, the risk is small |
| `writable-cgroups=true` | write access to the container's own cgroup subtree only | low: limits can be lowered inside, not raised past the container's own |
| `--privileged` (for comparison) | everything: all capabilities, all devices, no seccomp, no AppArmor | **a root in the container is root on the host.** Never recommended |

`--cap-add SYS_ADMIN` is not needed and does not even suffice. It is also close to `--privileged` in what it gives
away.

### 11.3 With no extra privilege: the `landlock` mode

A default `docker run` (Docker's seccomp and AppArmor, default capabilities, root inside the container) can still
confine a child with four unprivileged layers. `host.ts` `confineCommand` and `confine.c` implement them:

1. **A uid per deployment.** `setpriv --reuid/--regid --clear-groups --inh-caps=-all --bounding-set=-all`. A
   container's root may switch uid by default. This blocks signals to the host and the host's files by permissions.
2. **Landlock.** It allows file access only beneath `/usr`, the bun binary, the runner, the app and the child's own
   `/proc/self`. With ABI 4 (Linux 6.7+) it allows no TCP connect or bind. It needs no privilege and is allowed by
   Docker's default seccomp profile.
3. **seccomp.** The same deny list as bwrap's (`gen-seccomp.py`), loaded with `prctl`. It also refuses non-Unix
   sockets.
4. **RLIMIT_NPROC** (per uid, hence per deployment), plus `no_new_privs`.

**Why a helper.** Landlock and seccomp apply to the calling thread only, and to what it starts after. Bun already
has about ten threads before any script runs, and its async filesystem calls run on a thread pool. So the
confinement has to happen before Bun starts: a 110-line static C helper (`confine.c`) applies it, then `exec`s bun.
Bun has no API for any of it.

**Results** (`results/docker-tests.txt`; probes in the "escape probes" blocks):

| Probe | vm (today) | bwrap in Docker (§11.2) | landlock mode, default `docker run` |
|---|---|---|---|
| Host secret in env | escaped | blocked | blocked |
| `/proc/<host>/environ` | escaped | blocked | blocked (EACCES, Landlock and uid) |
| `/proc/<host>/cmdline` (`--instance-secret`!) | escaped | blocked | blocked (EACCES, Landlock) |
| Read / write the secret file | escaped | blocked | blocked (EACCES) |
| TCP to the host's port | escaped | blocked | blocked (seccomp; Landlock gives EACCES on its own) |
| Signal the host | escaped | blocked | blocked (EPERM, other uid) |
| List processes | — (3 in the container) | blocked | blocked (EACCES on `/proc`) |
| Fork bomb | escaped | blocked (`pids.max`) | blocked (stopped at 56–57, RLIMIT_NPROC) |
| Infinite loop | never ends | killed at 1 s | killed at 1 s |
| Memory cap | none | `memory.max` | **none of its own** (the container's `--memory` only) |

**Sabotage of this mode.** Each run drops one layer. The "every escape" test fails for each one except seccomp
alone:

| Dropped | What reappears |
|---|---|
| `seccomp` | nothing: Landlock still refuses TCP (EACCES) |
| `landlock` | the host's command line |
| `seccomp,landlock` | the command line, and TCP to the host |
| `uid` (child stays root) | signalling the host, and the fork bomb (RLIMIT_NPROC does not bind root) |
| `fs` (Landlock allows all of `/`) | the host's command line |
| `env` | the host secret in env |
| `cgroup` (no RLIMIT_NPROC) | the fork bomb |
| `timeout` | the loop runs until the test's 20 s limit (3 tests fail: the loop, the user-time test's loop, the pool) |

**What this mode lacks** compared with namespaces:
- **No per-call memory cap.** A memory hog takes the whole container, and with it the backend and every deployment
  in it.
- **The host's filesystem layout is visible** to the extent Landlock allows reads: `/usr` and the app's own files
  only, which is fine.
- **Abstract Unix sockets and signals between processes of the same uid** are not covered by Landlock before ABI 6
  (Linux 6.12). The per-deployment uid covers signals.
- **A shared network namespace.** TCP and UDP are refused by seccomp and Landlock, but the child is in the same
  network namespace.

It is a real boundary for files, network, signals and processes. It is not one for memory. For a self-hoster who
wants the timeout and isolation from the app's bugs, it is the zero-configuration choice. For a multi-tenant cloud,
use namespaces.

### 11.4 A container per tenant

The other way to need no extra privilege: each deployment's child is its own container, with `--network none
--read-only --memory 128m --pids-limit 64 --cap-drop ALL --user 65534` and Docker's default profiles. It talks to
the host over a Unix socket in a shared directory, because an inherited IPC descriptor cannot cross `docker run`
(`container-rtt.ts`, `results/container-rtt.jsonl`):

| | Start (spawn to connected) | Round trip p50 / mean / p99 |
|---|---|---|
| Plain child, Unix socket | 17.5–21 ms | 49 / 73 / 389 µs |
| Container per tenant, Unix socket | **200–229 ms** | 99 / 170 / 980 µs |

- **The isolation is Docker's.** It includes a real memory cap per container.
- **The backend needs the Docker API.** Access to the Docker socket is root on the host, which makes this an
  orchestrator's design, not a self-hosted one.
- **The cost.** A tenth of a second more per start, and about twice the round trip, through the extra veth/overlay
  and process layers. It also costs one container per deployment.
- **Recommendation.** It fits a cloud's control plane: Kubernetes, a pod per tenant, maybe with gVisor. It does not
  fit the self-hosted image.

### 11.5 Per-call cost inside Docker

`docker/bench-docker.sh` runs `bench.ts` on the host and in containers, back to back on the same VPS. The figures
are p50 / mean µs per call, and calls per second under concurrency:

| Function | host, vm | host, bwrap | Docker, vm | Docker, bwrap (§11.2) | Docker, landlock (§11.3) |
|---|---|---|---|---|---|
| Empty query | 17 / 24 | 77 / 127 | 19 / 30 | 68 / 123 | 59 / 78 |
| 1 × `db.get` | 38 / 50 | 223 / 382 | 29 / 40 | 273 / 413 | 131 / 204 |
| 10 × `db.get` | 140 / 154 | 1267 / 1755 | 144 / 159 | 1552 / 1908 | 1086 / 1525 |
| 100 × `db.get` | 1151 / 1209 | 18293 / 18847 | 1131 / 1183 | 11517 / 14096 | 10940 / 13091 |
| Page of 100 | 351 / 351 | 899 / 1003 | 349 / 361 | 924 / 1017 | 968 / 1069 |
| Insert mutation | 76 / 96 | 202 / 273 | 84 / 104 | 241 / 345 | 218 / 337 |
| listByTenant, 8 / 32 callers | 4200 / 4262 | 2882 / 2770 | 4256 / 4310 | 2973 / 2920 | 2823 / 2965 |
| insertItem, 8 / 32 callers | 9003 / 10189 | 3025 / 5149 | 10646 / 8550 | 6316 / 7606 | 6278 / 7613 |
| Spawn to ready | — | 53 ms | — | 61 ms | 49 ms |

- **Docker adds nothing measurable.** The differences between the host and Docker columns are within the unpinned
  runs' noise: the cross-CPU wakeups of §4.3 dominate both.
- **The landlock mode costs the same as bwrap,** since the cost is the process boundary.

### 11.6 What the image needs

- **bubblewrap,** about 100 KiB from Debian, and **the confine helper,** compiled in the build stage (static, about
  800 KiB with glibc, much less with musl).
- **The child runtime.** The image has only the compiled `bunvex-local-backend`. A compiled Bun binary can act as
  plain Bun: `BUN_BE_BUN=1 ./binary -e …` worked on Bun 1.4.2. A hidden subcommand can also run an embedded child
  runner. Either way, no second Bun is needed in the image.
- **The AppArmor profile and the seccomp JSON** ship as files for the operator, for the namespaces mode only.
- **The compose file** gets the knobs in its pass-through list. A commented block lists §11.2's options.

## 12. Implementation plan and effort

### 12.1 Where the seam is

Every function call enters app code at one of a handful of places:
- `invoke()` → `f.handler(appContext(f.handler, ctx), args)` for queries, mutations and nested calls
  (`packages/server/src/functions.ts:1862-1896`);
- `runAction` (`:2674`);
- `runHttpAction` (`:2868`);
- the room gates (`:2523`).

Each runs a `FunctionDef.handler` that a `CodeVersion` handed out (`code-version.ts:498-593`). The prototype's
stand-ins prove the seam. A "remote code version" exposes the same fields:
- `functions` (stand-in `FunctionDef`s);
- `moduleHashes`;
- `rooms`, `router` and `crons`;
- `moduleLoads` and `frameMaps`.

Each stand-in's handler forwards to a child and answers its ops with the host's real `ctx`. `Functions`, the engine
and sync never see the difference.

### 12.2 What changes and what does not

**Unchanged:**

| Area | Why |
|---|---|
| `packages/core`: engine, `Tx`, committer, OCC, query cache, persistence, retention, search and vector indexes | the engine runs `TxBody = (db) => Promise` (`engine.ts:3596-3627`) and never sees a handler; the stand-in runs inside that body |
| `packages/persistence`, `file-storage`, `protocol`, `values`, `client`, `react` | not on the path (values may gain a wire codec next to `toJsonValue`) |
| `packages/server`: `sync.ts`, `scheduler.ts`, `cron-executor.ts`, HTTP routing in `server.ts`, `system-functions.ts`, the push and code-store logic except their `CodeVersion.load` calls | they call `Functions`, whose definitions are stand-ins |
| App code | an app is the same bundle, with the same `bunvex/server` and `bunvex/values` imports; `examples/pagination` ran unmodified (§14.3) |

**Changed:**

| File / module | Change |
|---|---|
| `packages/server/src/code-version.ts` (611 lines) | the 8 `CodeVersion.load` call sites go through one factory that picks `vm` or the remote version (push.ts ×4, code-store.ts ×2, server.ts, test-function.ts) |
| new `packages/sandbox` (child runtime and host transport) | child entry, wire codec, `bunvex/server` shim with the real builders and validators, analysis in the child, op client |
| `packages/server/src/functions.ts` (2974 lines) | remote `FunctionDef` stand-ins with `args`/`returns` from the analysis JSON (`validatorFromJson`, `values/src/validators.ts:410`); the op dispatcher with per-kind checks; user-time charging |
| `packages/core/src/determinism.ts` | a `chargeUserTime(ms)` next to `pausingUserTime` (`:121`), so the engine's timer counts the child's reported time instead of the wait; the child gets its own copy of the deterministic globals (seeded `crypto.getRandomValues`, refused timers, frozen `performance.now`) |
| `app-errors.ts`, `errors.ts`, `stack-map.ts` | `BunvexError` rebuilt on the host from wire errors; stacks carry `bunvex:/vN/path` URLs, mapped by the host's `mapStack`; `Error.prepareStackTrace` formatting moves to the child with the frame maps |
| `logs.ts`, `log.ts` | console rendering (object-inspect, patched) in the child; lines and audit records sent as ops; limits (256 lines, 32 KiB) on the host |
| `env-scope.ts` | `process.env.X` is synchronous and reactive (each read is in the read set): the call carries the variables, and the child reports the names read |
| `storage.ts`, `action-fetch.ts`, `http-actions.ts`, `web-*.ts` | bytes and streams over the bridge in chunks; `fetch` still goes through `isolateFetch` and its SSRF screen on the host |
| `local-backend.ts`, `server.ts` `createServer` | the knobs and flags of §10, the start-up self-test |
| `docker/` | bubblewrap, the helper, compose knobs, docs |
| `definition-eval.ts` (662 lines) | push-time evaluation of `bunvex.config` in a child, for a cloud only |

### 12.3 PR by PR

One concern per PR. Sizes count code plus tests, roughly:
- **S** is under 300 lines;
- **M** is 300–800;
- **L** is 800–1500.

| # | PR | Size | Risky parts |
|---|---|---|---|
| 1 | **Executor seam and knobs.** One `loadCode()` factory for the 8 call sites; `BUNVEX_FUNCTION_SANDBOX`, the isolation knob and the flags; `vm` the only value implemented. No behaviour change | S (≈250) | none: refactor |
| 2 | **Wire protocol and child runtime.** `packages/sandbox`: framing (Bun IPC JSON, tagged values, message size caps at Convex's 16 MiB), the child entry, the `bunvex/server` shim with real builders, analysis in the child (functions, validators JSON, router, crons, rooms) | L (≈1200) | the shim must export everything a `_generated/server.js` imports; analysis must match `CodeVersion.analyze` exactly (`code-version.ts:498-593`) |
| 3 | **Queries and mutations over the bridge.** Stand-ins with validators; `db` (get, the whole query chain with streamed iteration, writes, `normalizeId` (sync: a table-number map shipped with the call), `system`, `table()`), `auth`, `scheduler`, nested `runQuery`/`runMutation`, `ctx.meta` (`getSnapshotTs` is sync: sent with the call); per-call determinism; user time charged from the child; env reads reported | L (≈1500) | the synchronous APIs; chain-building errors that today throw synchronously; read-set and observed-time report-backs; the async-context state restored around every op (8 ALS instances) |
| 4 | **Logs and errors.** Console rendering in the child, log owners, `log.audit`; `BunvexError` with `data`; source-mapped stacks; `console.trace` | M (≈600) | byte-for-byte log and stack parity (the existing frame tests are the oracle) |
| 4b | **Unhandled rejections fail the function** (DV-528, owner 2026-10-20). Under `process`, a rejection nothing handled once the call's microtasks have drained fails the query, mutation or action with the value as thrown, its app frames mapped (Convex's `UnhandledPromiseRejection` termination, `environment/udf/mod.rs:1102-1127`); **built (STUDY-171 §13)**: a child runs several calls at once until PR 9, so it attributes a rejection by checkpoint (each call's code resumed and its microtasks drained with the call named), which `vm` cannot (DV-528 keeps `vm` logging it); a query's or mutation's answers reach it in Convex's batches. `bridge-parity.test.ts`'s three unhandled cases become failures, compared with Convex's binary in `packages/differential` | S (≈200) | a rejection that lands after the call's answer (an unawaited operation): Convex drains before it answers, so the child must too |
| 5 | **Actions.** `fetch` through the host's `isolateFetch` (SSRF screen, proxy, meters, abort on timeout), streamed; `ctx.storage` (`get` → Blob, `store`, bytes in 1 MiB chunks); `ctx.vectorSearch` with a recorded filter; `runAction`; rooms ctx; the action cut-off, then a kill. **Built** (STUDY-171 §12): about 1,250 lines of code and 1,100 of tests; bytes as chunk frames on the one socket with credit (§14.1's measured result); room definitions as stand-ins whose gates run in the child | L (≈900) | streams both ways; the 16 MiB+ storage path (§14.1) |
| 6 | **HTTP actions.** The router stand-in; `Request` in and `Response` out as chunk streams; `trackedFormData`; the 100 MiB response cap; a body that streams after its handler returned; PR 4b's rejection checkpoints. **Built** (STUDY-171 §14): the response read in the child as the server reads it (its known-length body whole, a stream checked in the handler's turn), PR 5's chunk frames and credit both ways, a mark for the app's chunk past the cap, a multipart body parsed by the host as Convex's `form/parseMultiPart`; the call ends with its body, as Convex's isolate | M (≈500) | streaming backpressure; the content-type and body tests |
| 7 | **Components.** One child per component instance and version, or the namespace switch in one child; `resolveCall` stays on the host. **Built** (STUDY-171 §15): the namespace switch, each instance a `CodeVersion` of its own in the app's child (measured: 81 MiB for 16 instances against 892 MiB with a child each, a push 0.6 s against 3.5 s), released versions forgotten by the child | M (≈400) | DV-492 parity (each instance's modules evaluated once) |
| 8 | **Linux isolation.** bwrap command, shipped seccomp BPF (generated at build), cgroup manager (delegated root, `init` leaf, deployment and child levels), the confine helper for `landlock`; the self-test and §10.4's errors | L (≈900) | the helper is native code (C, built in CI and in the image); kernel and AppArmor variance between distributions |
| 9 | **Lifecycle.** A process per deployment and code version; hot swap and drain on push; OOM, timeout and crash reporting with Convex's messages; respawn; the elastic one-call pool (Q3); idle shrink; **an action past its timeout ends its own call's process at the timeout, with no grace, as Convex terminates its isolate** (owner, 2026-10-21, STUDY-171 §12.11: until then PR 5's cut-off, then a kill after 1 s); **parity: an unhandled rejection left by code Bun resumes itself (a native completion: `crypto.subtle`, a `Blob`'s or `Response`'s read) fails its call with several calls under way, and one such code handles late in the same turn under Bun 1.4.3+ fails it too** (owner, 2026-10-21, STUDY-171 §13.7, Q-PR4b-1: until then only the one call running fails, per DV-528's note); **parity: an HTTP router that overrides `lookup` routes as in-process** (the child says at analysis whether the router's `lookup` is `HttpRouter`'s, and the request is routed in the child when it is not; owner, 2026-10-21, STUDY-171 §14.6, Q-PR6-4: until then `process` routes over the analyzed routes with `HttpRouter`'s `lookup`) | M (≈700) | races between a push, a kill and in-flight calls; memory accounting per pool |
| 10 | **`"use node"` actions in a child** (Q5). `node_modules` mounted read-only; unhandled rejection and `process.exit` fail the action and exit the child (DV-500); `NODE_ACTION_USER_TIMEOUT_SECS` | M (≈500) | external packages that expect a writable home or a network |
| 11 | **Docker image and docs.** bubblewrap and the helper in the image; compose knobs; the AppArmor profile and seccomp JSON for the namespaces mode; self-hosting docs; the instance secret off argv (Q11) | S (≈250) | operators' kernels and Docker versions (`writable-cgroups` is recent) |
| 12 | **Parity CI.** A Linux job that runs the suites of §12.4 with `BUNVEX_FUNCTION_SANDBOX=process` | S (≈150) + CI time | the runner needs user namespaces and a writable cgroup; if the CI image restricts user namespaces as Ubuntu 24.04 does, the job loads §13.5's profile |

**Total: about 7,000–8,000 lines over 12 PRs** (plus 4b, added on 2026-10-20), of which PRs 2, 3, 5 and 8 are the bulk. Optional later:
push-time evaluation (`definition-eval.ts`) in a child for a cloud (M), and spin-before-block or shared-memory
transport if per-op latency matters (S–M, research).

**Order.** PRs 1–4 (and 4b) are a usable self-hosted `process` mode for queries and mutations. Adding 5, 6, 9 and 8 makes
it a cloud executor. PR 10 can follow PR 2 on its own.

### 12.4 How parity is proven

The executor knob is read from the environment, so every suite that spawns a backend runs under C unchanged.
In-process suites run under it if `createServer` reads the knob by default.

| Suite | Tests | Under C by |
|---|---|---|
| `examples/` e2e (`bun run test:examples`, harness spawns `local-backend.ts`) | ≈75 | env only |
| `packages/differential` (against Convex's own binary) | ≈119 | env only; also the oracle for the timeout and OOM messages, which only C can match |
| `packages/cli/test` (deploy, dev, error stacks, external packages) | ≈197 | env (spawned) and `createServer` default (in-process) |
| `packages/server/test` pushed-code suites (`deployCode`, `CodeVersion.load`, `PushService`: components, frames, logs, HTTP actions, source positions, run-test-function, push) | ≈167 | `createServer` default |
| `bench/process-sandbox/sandbox.test.ts` | 10 | its own modes |

The 143 `packages/server` test files that `register` in-process handlers do not exercise an executor, and need not.

**The bar.** The same pass list under `vm` and `process` in CI. A per-test allow-list of differences is permitted
only for the documented divergences: the timeout, the memory cap and the kill semantics, where C matches Convex
and `vm` does not. On top of that, the differential suite compares limit messages with Convex's binary.

## 13. Fixes the first round found (prototyped and measured)

All on the VPS, unpinned unless stated. Raw lines are in `results/fixes-*.jsonl`, and the bench is
`fixes-bench.ts <part>`.

### 13.1 User time counted in the child, without IPC

- **The fix.** The child stamps every op and every `done` with `ran`: the milliseconds its JS ran since the call
  started or since its last op was answered, by its own clock.
- **On the host.** It adds these up and fails the call with Convex's message once the sum passes the budget. The
  engine's cooperative timer is paused for the wait (a real executor would charge it, §12.2). A child that stops
  talking (a loop) is killed by the host's backstop at the budget **plus 50 ms of slack** for IPC transit.
- **The cost of trusting the child.** A child can under-report. It then gains at most the slack per stretch of JS,
  and the system timeout (15 s) still bounds the whole call.

Sequential inserts in one mutation (`sb:insertMany`), 1 s budget:

| Inserts | vm | Host accounting (round 1) | Child accounting (round 2) |
|---|---|---|---|
| 1 000 | ok, 94 ms | ok, 98 ms | ok, 204 ms |
| 2 000 | ok, 103 ms | ok, 178 ms | ok, 169 ms |
| 5 000 | ok, 245 ms | **timeout** at 1045 ms | ok, 622 ms |
| 10 000 | ok, 561 ms | **timeout** | ok, 1816 ms |
| 15 000 | ok, 615 ms | **timeout** | ok, 2633 ms |

The wall time still grows with the round trips. Convex counts syscall waits as system time too (`timeout.rs:101-112`),
so a 10 000-insert mutation now behaves as on Convex: inside its user budget, and well inside the 15 s system one.

### 13.2 Killing only the stuck request: a pool per deployment

`poolSize: N` runs each call in a free process of a pool of N (calls queue when all are busy). A timeout or an OOM
kills only that call's process, which is then replaced. The test: 16 callers of a page-of-20 query for 2 s, while
one call spins into its timeout.

| | Idle memory (cgroup) | Busy | Seq. p50 | Calls/s, 8 / 32 callers | During the spin: calls/s, failed, p99 |
|---|---|---|---|---|---|
| One shared process (round 1) | 7.5 MiB | 27.5 MiB | 656 µs | 3424 / 2277 | 1404/s, **15 failed**, 52 ms |
| Pool of 1 | 7.8 MiB | 19 MiB | 631 µs | 1456 / 1334 | 672/s, 0 failed, **1094 ms** (queued behind the spin) |
| Pool of 2 | 12.7 MiB | 25.1 MiB | 727 µs | 2342 / 2047 | 1883/s, 0 failed, 32 ms |
| Pool of 4 | 23.1 MiB | 53 MiB | 534 µs | 2800 / 2654 | 2746/s, 0 failed, 16 ms |

- **One process per in-flight request.** It is the pool with N = concurrency. Its marginal cost is one process
  (about 5–6 MiB idle, about 13 MiB busy).
- **Spawning per request.** It costs 55–75 ms (§5.6), so it is never done on the request path. A warm spare
  replaces a killed process off the path.
- **On these 2 vCPUs, a pool of 4 serves within 20 % of one shared process.** A pool smaller than the concurrency
  costs throughput, because each process runs one call at a time.

### 13.3 The memory cap: per request or per process

With the pool, each process runs one call and has its own cgroup leaf, so the per-process cap *is* the per-call
cap, as Convex's per-isolate heap limit is. The prototype now nests cgroups as `<root>/<deployment>/<child>`:
- `cpu.max` sits on the deployment, so a pool cannot multiply a deployment's CPU share;
- `memory.max` and `pids.max` sit on each child.

The cost is §13.2's memory column. With the nested cgroups, the 128 MiB test cap (`sb:allocate`) still fails with
Convex's message and `memory.peak` ≤ the cap (test 5, run with one shared process; the OOM path inside a pool was
not tested separately). Without a pool, the cap is per deployment (Q4).

### 13.4 CPU affinity and op batching

**Affinity.** `cpuList` pins the child with `taskset`, and `taskset -p` pins the host's main thread
(`results/fixes-affinity.jsonl`). The figures are p50 µs per call, and calls/s at 8 callers:

| | Empty query | 1 × `db.get` | 10 × `db.get` | Insert | listByTenant, 8 callers |
|---|---|---|---|---|---|
| Unpinned | 68 | 160 | 2079 | 215 | 3563/s |
| Host and child on the same CPU | 51 | 115 | **613** | 206 | 3075/s |
| Host and child on different pinned CPUs | 104 | 206 | 1522 | 390 | 3180/s |

- **Sequential ops get 3.4× faster** on one CPU, because a same-CPU wakeup is cheap and a cross-CPU one on this KVM
  guest is not.
- **Throughput drops 14 %** at 8 callers on this 2-vCPU box, because host and child no longer run in parallel.
- **Recommendation for a cloud host with many cores:** pin each deployment's processes and the host thread serving
  them to one core, or to the two hyperthreads of one core, and spread deployments across cores. The kernel's own
  placement is the worst case measured here.

**Batching.** With `batchOps`, the ops a call starts in one tick (`Promise.all`) travel as one message, and the
answers of one tick come back as one (`results/fixes-batch.jsonl`). The figures are p50 µs:

| | 10 parallel `db.get`s | 100 parallel | 10 sequential | listByTenant, 8 callers |
|---|---|---|---|---|
| vm | 176 | 1112 | 144 | 5714/s |
| Unbatched | 1528 | 3372 | 2839 | 2968/s |
| Batched | **274** (5.6×) | **1775** (1.9×) | 1124 | 2922/s |

- **Parallel reads get within 1.6× of `vm`.**
- **Sequential reads cannot be batched.** The sequential column's gain is unpinned noise, not batching.
- **Throughput under load does not change,** because concurrent calls' messages were not batched across calls.
- **Recommendation:** batch per tick, since it costs nothing. Combined with pinning, it is the cheap path to
  "under 0.1 ms per op".

### 13.5 Unprivileged operation on Ubuntu 24.04

`unprivileged.sh` (`results/unprivileged.txt`) keeps `kernel.apparmor_restrict_unprivileged_userns=1`:

1. **As a service user, bwrap fails** ("loopback: Failed RTM_NEWADDR"). The user namespace is created, but Ubuntu's
   `unprivileged_userns` profile strips its capabilities.
2. **An AppArmor profile for a private copy of bwrap fixes it.** This is what Ubuntu ships for browsers:
   ```
   profile bunvex-study-bwrap /opt/bunvex-study/bin/bwrap flags=(unconfined) {
     userns,
   }
   ```
   The copy is mode `0750`, group `bunvex-study`.
   - The system `/usr/bin/bwrap` stays restricted for everyone else.
   - Another user cannot run the copy ("Permission denied").
   - So the relaxation is scoped to the service, not the machine.
3. **The tests as the service user, in a systemd unit with `Delegate=yes`:** 10 of 10 pass. The unit owns its
   cgroup. The host moves itself into a leaf (`init`) and creates `sandbox/<deployment>/<child>` below it
   (`SANDBOX_CGROUP_ROOT=auto`).
4. **The same without `Delegate=yes`** fails at the first `mkdir` (EACCES). That is the error §10.4 would name.

So the production setup is: a service user, a unit with `Delegate=yes`, a bwrap the unit's group alone may run,
and its AppArmor profile. No root at run time, and no system-wide sysctl change.

## 14. Gaps from the first round

### 14.1 Storage and search over the bridge: the cost of bytes

The host sends `size` bytes to the child, which acks (`bytes-bench.ts`, `results/bytes.jsonl`, p50):

| Size | Bun IPC JSON (base64, as `wire.ts`) | Unix socket, binary `bun:jsc` frames |
|---|---|---|
| 1 KiB | 39 µs | 102 µs |
| 64 KiB | 362 µs (173 MiB/s) | 414 µs (151 MiB/s) |
| 1 MiB | 6.3 ms (158 MiB/s) | 3.3 ms (302 MiB/s) |
| 8 MiB | 31.6 ms (254 MiB/s) | 83 ms (96 MiB/s; the prototype's frame reader copies on every chunk) |

- **The rate.** Both carry bytes at 150–300 MiB/s, against zero copies in-process today. A 16 MiB `storage.get` or
  HTTP body would add 60–100 ms.
- **The plan (PR 5).** Bytes go in 1 MiB chunks over a binary side channel with a non-copying reader: a second
  socket or a pipe, with no base64. Large files could also pass as a file descriptor, through a memfd or an
  `SCM_RIGHTS` Unix socket, which needs a native helper. Small values stay on the JSON channel.
- **Search.** Text and vector search are a recorded filter plus a result page. They are no different from the
  query pages already measured (a page of 100 adds 0.35–0.65 ms).
- **Built (PR 5, STUDY-171 §12.4).** Not a second socket: the chunks are frames of their own on the one socket (a
  length with its top bit set, the stream's id, the bytes), so their order with the messages around them is kept for
  free, and a credit window (4 MiB, by half) keeps a reader that does not read from filling memory. The reader hands a
  chunk's bytes over as they arrive, without joining them, and a writer sends a chunk's header then its bytes, so the
  bytes are not copied on the way. Measured on the VPS (STUDY-171 §12.9): a 16 MiB + 1 byte store, get and delete moves 32 MiB at 216 MiB/s under `process` against 553 MiB/s under `vm` (+90 ms), 154 MiB/s before the copies were removed; a 1 MiB `fetch` body streams at 120–160 MiB/s. No file descriptors were needed.

### 14.2 Noisy neighbour: CPU fairness between two deployments

Deployment A burns CPU from 4 callers in a pool of 2 (so it can take both vCPUs). Deployment B serves small queries
from one caller (`results/fixes-neighbour.jsonl`):

| A | B: calls/s, p50 / p99 | A's burns/s |
|---|---|---|
| none | 1502, 0.5 / 2.2 ms | — |
| unlimited | 1960, 0.4 / 2.8 ms | 27 |
| `cpu.max` 1 CPU (on A's deployment cgroup) | 2185, 0.4 / 2.4 ms | 23 |
| `cpu.max` 0.5 CPU | 1777, 0.4 / 2.8 ms | 11 |

- **B is not hurt measurably,** even next to an unlimited A. The kernel's fair scheduler shares the CPUs, and B's
  calls are short.
- **B is faster next to a busy A than alone.** With both vCPUs awake, the cross-CPU wakeups of §4.3 cost less.
- **`cpu.max` caps A as set:** 27 → 23 → 11 burns/s.
- **What cgroups do not cover is the host.** The engine, the transactions and the op dispatch of every deployment
  run in the one host process. A neighbour that floods *ops*, rather than computing, competes in the host's event
  loop. That needs per-deployment op and concurrency limits on the host (today's `APPLICATION_MAX_CONCURRENT_*`
  permits are per server), or one host per group of tenants. It was not measured here.

### 14.3 An existing app end to end over HTTP

`examples/pagination`, unmodified: its `messages.ts`, its `_generated/server.js` and its schema. It ran in both
executors behind the production `createServer`, with HTTP clients in the same process on the same two vCPUs, for
10 s per point (`example-workload.ts`, `results/example-http.jsonl`). The mix is 60 % `messages:list` (a first page
of 10), 20 % `listByAuthor` and 20 % `send`, after seeding 2 000 messages:

| Concurrency | vm: req/s, p50 / p99 ms | bwrap: req/s, p50 / p99 ms | Change | bwrap, pool of 2 |
|---|---|---|---|---|
| 8 | 1797, 3.66 / 13.0 | 1317, 5.26 / 18.0 | −27 % | 1264 (−30 %) |
| 32 | 1976, 13.5 / 36.9 | 1865, 15.8 / 38.9 | −6 % | 1311 (−34 %) |

- **The app needed no change.** Its generated `server.js` imports `queryGeneric` and the rest from `bunvex/server`,
  which the child's shim provides.
- **The stand-ins skip argument validation,** which favours C slightly, as in §5.
- **The cost depends on concurrency.** At concurrency 32, HTTP, JSON and the engine dominate, and C costs 6 %. At
  8 the round trips show more.
- **A pool smaller than the concurrency** limits each process to one call at a time and costs a third of the
  throughput. That is why Q3 recommends an elastic pool sized to the concurrency.
