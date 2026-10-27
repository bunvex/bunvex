# STUDY-194 — The execution protocol between the main thread and execution workers
<!-- index: The execution protocol (STUDY-190 PRs 2–4, STUDY-24 A2): Convex's function runner (the request, the snapshot and metadata at a timestamp, the outcome, how the backend commits it), bunvex's in-thread call path, the messages and their encoding (a prototype), snapshots, metadata by epoch, code versions, nested calls, OCC, failures, backpressure, a five-PR plan | decided (owner): Q1–Q6 and AD-47 (2026-10-26), Q7 (2026-10-27); PR 2a is #895; PR 2b planned (§10), Q8–Q10 decided (2026-10-27) -->

- **Status:** decided (owner): every §8 recommendation, Q1–Q6 on 2026-10-26 (Q4 is AD-47) and Q7 on 2026-10-27
  (the codec round-trips in-thread calls under the tests only). PR 2a is #895: the boundary, the codec and the permit
  order (§9); on DO `c-4` uncached +0.7 % and insert −2.2 % against `main`. PR 2b is planned in §10; its Q8–Q10
  were decided by the owner on 2026-10-27, as recommended.
- **Convex source read:** `precompiled-2026-10-24-bb31399`. Files:
  - `crates/function_runner/src/{lib,server,in_process_function_runner,in_memory_indexes,module_cache}.rs`;
  - `crates/isolate/src/client.rs`, `crates/isolate/src/environment/udf/{async_syscall,phase,mod}.rs`;
  - `crates/application/src/application_function_runner/mod.rs`, `crates/application/src/cache/mod.rs`,
    `crates/application/src/lib.rs`;
  - `crates/database/src/{transaction,reads,committer,database,subscription,token}.rs`;
  - `crates/udf/src/{validation,action_callbacks}.rs`, `crates/sync/src/worker.rs`;
  - `crates/pb/protos/{common,outcome,errors,usage}.proto`, `crates/pb/src/error_metadata.rs`;
  - `crates/common/src/{knobs,document}.rs`, `crates/common/src/types/timestamp.rs`.
- **Related:**
  - [STUDY-190](STUDY-190-offthread.md) §1.2, §4.5 and its plan (§5): PRs 2–4 run queries, mutations, then actions
    on a pool of Bun Workers, and "need STUDY-24 A2's protocol written down first". This is that study.
  - [STUDY-24](STUDY-24-horizontal-scaling.md) §4.2 A2 (DV-115): execute anywhere at the timestamp the leader hands
    out, commit on the leader, retries on the leader.
  - [STUDY-184](STUDY-184-horizontal-draft.md): Convex's real shape (one backend, stateless function runners).
  - [STUDY-171](STUDY-171-function-sandbox-seam.md): the `process` executor, its wire (§7.2), its values and
    errors codec (§8.3), its epochs for the catalog and variables (§8.4), its user time and backstop (§8.5), its
    actions (§12).
  - PR 1 of STUDY-190, #878: the SQLite writer thread, its wire (`packages/core/src/persistence/sqlite-writer.ts`)
    and its fail-stop.
  - Decisions: DV-573 (module state per worker), DV-574 (`MAX_ISOLATE_WORKERS`, workers up to the core count),
    DV-164 / DV-165 (one `vm` context per code version, module state per version).
  - Prototype: [`bench/offthread/outcome-wire.ts`](../../bench/offthread/outcome-wire.ts), results in
    [`results/mac/outcome-wire.md`](../../bench/offthread/results/mac/outcome-wire.md).

## 0. In short

1. **Convex's seam is one call, `FunctionRunner::run_function`** (`crates/function_runner/src/lib.rs:86-105`). The
   backend hands the runner a function, its arguments, an identity, a **repeatable timestamp** and the writes its
   own transaction already holds. The runner reads the store itself at that timestamp, runs the function, and hands
   back:
   - the function's outcome (result or JS error, log lines, observed time and identity);
   - its **read set and its document writes** (`FunctionFinalTransaction`, `lib.rs:154-220`);
   - its usage counters.

   The backend merges the reads and writes into its transaction (`apply_function_runner_tx`,
   `transaction.rs:591-618`), recomputing every index update from the documents, and commits through its one
   committer. OCC retries re-run the whole call at a new timestamp, from the backend.
2. **Nothing crosses for metadata or code.** The runner rebuilds the table, index, component and schema registries
   from the store at the timestamp, cached by each system index's last-modified timestamp, which the request
   carries (`in_memory_indexes.rs:533-591`). It reads the function's module row in the function's own transaction and
   loads the source by its package hash (`phase.rs:309-334`, `module_cache.rs:41-55`). A push sends the runner
   nothing.
3. **bunvex's call path today is one closure** (`TxBody`) that the engine runs in a `Tx` on the main thread. The
   closure resolves the path, checks the arguments, takes the permit, runs the handler, checks the result and
   collects the logs. The engine around it keeps the query cache, the commit, the retries and the subscriptions
   (§3).
4. **The protocol (§4)** cuts exactly there:
   - **the worker runs today's closure;**
   - **the main thread keeps today's engine around it.**

   A request names the call (path, arguments as JSON text, identity, the timestamp, the code version, the epochs of
   the metadata it needs). The outcome returns the result text, the read set, a mutation's writes (index entries
   included), the log lines, the counters and the after-commit effects. Messages are strings in one format, PR 1's
   length-prefixed fields; the prototype found no encoding that beats it by more than the run-to-run noise, and
   structured clone costs 1.5–2× (§4.2).
5. **Everything an app observes stays as today (§2, §5).** No divergence is needed. Six questions for the owner
   (§8):
   - who computes the index writes;
   - how metadata reaches a worker;
   - what a worker's death does;
   - how the in-thread executor is chosen;
   - whether workers get an index cache;
   - the store connection budget.

## 1. How Convex does it

### 1.1 The seam

- `FunctionRunner` is a trait (`crates/function_runner/src/lib.rs:86-152`). Its `run_function` takes:
  - the function's type and runtime;
  - the identity;
  - `ts: RepeatableTimestamp`;
  - `existing_writes`;
  - a log line sender;
  - `FunctionMetadata` (the validated path and arguments, and the query journal) or `HttpActionMetadata`;
  - the default system environment variables;
  - `in_memory_index_last_modified: BTreeMap<IndexId, Timestamp>`;
  - the execution context (request id, caller, parent scheduled job).

  It returns `(Option<FunctionFinalTransaction>, FunctionOutcome, FunctionUsageStats)`.
- The open code has one implementation, `InProcessFunctionRunner`
  (`crates/function_runner/src/in_process_function_runner.rs:113-424`). Convex Cloud's remote one is not in the open
  code. Its traces are:
  - `FunrunClient` named in comments (`in_process_function_runner.rs:180, 220`);
  - a timestamp kind "serialized as a funrun::RepeatableTimestamp proto", which "the server trusts … was
    repeatable" (`crates/common/src/types/timestamp.rs:32-36`);
  - `Database::index_page`, whose comment speaks of "a funrun named by `_index` document ID alone"
    (`crates/database/src/database.rs:1686-1790`, exposed as `Application::index_page`,
    `crates/application/src/lib.rs:1180-1194`);
  - the message types in `crates/pb/protos/` (§1.9).

### 1.2 The request

The backend builds it in `function_runner_execute`
(`crates/application/src/application_function_runner/mod.rs:431-502`):

- **Before the call**, in the backend's own transaction at its begin timestamp, `ValidatedPathAndArgs` resolves
  the path and its visibility and checks the arguments against the function's validator
  (`crates/udf/src/validation.rs:490`, `check_args` at `:692`). A failure is an outcome without a call
  (`application_function_runner/mod.rs:1284-1307`).
- Then the permit, for a query (`cache/mod.rs:699`). A mutation takes it earlier, per attempt, before its
  transaction begins and so before this check (`acquire_mutation_permit`, `application_function_runner/mod.rs:990`;
  Convex's d328f85, in `bb31399`): its snapshot then has what committed while it waited. A recorded session request
  is still answered without one. Scheduled and cron mutations keep the old order (transaction, permit, check).
- `ts` is the transaction's begin timestamp. `existing_writes` are its writes so far, normally none
  (`application_function_runner/mod.rs:460-462`). The function tester's standalone module is one case that has
  some.
- `in_memory_index_last_modified` comes from the backend's snapshot at `ts`
  (`application_function_runner/mod.rs:446-450`): for each system index kept in memory, the timestamp it last
  changed.
- The arguments travel as JSON (`ValidatedPathAndArgs.args` is `bytes` in `common.proto:7-14`).

### 1.3 The snapshot and the metadata at that timestamp

- The runner reads through a persistence reader pinned at `ts` (`RepeatablePersistence::read_snapshot(ts)`,
  `in_process_function_runner.rs:274-279`). It does not hold a database snapshot of its own.
- `InMemoryIndexCache::begin_tx` (`in_memory_indexes.rs:533-591`):
  - checks that no last-modified timestamp is ahead of `ts`;
  - loads the table registry, then the index, component and schema registries (`load_registries`, `:495-527`);
  - caches each by deployment and the last-modified timestamp of the system indexes it is built from
    (`:259-306, :309-358`).

  So metadata is versioned by timestamp, and a runner fetches it only when it changed.
- The same cache holds whole in-memory system indexes keyed by `(index id, last modified)` (`IndexCacheKey`,
  `:118-123`, `get_or_load`, `:224-255`). Reads of user tables go to the persistence reader.
- Table counts and text search come from the backend's snapshot in-process (`in_process_function_runner.rs:258-265`).
- `make_transaction` sets the creation time from `max(wall clock, snapshot)` (`in_memory_indexes.rs:98-100`,
  `CreationTime::for_transaction`, `crates/common/src/document.rs:225-228`).

### 1.4 Code

- The function's module is read **in its own transaction**: `ModuleModel::get_metadata`, then the source package
  (`crates/isolate/src/environment/udf/phase.rs:309-334`). The module row is in the read set, so a push invalidates
  the queries that ran the old code.
- The function's environment variables and `_udf_config` are read the same way (`phase.rs:186-200`). The latest
  source package is read on a snapshot clone that records no read (`phase.rs:202-220`).
- The source is fetched from the modules storage and cached by `(deployment, package sha256, module path)`
  (`module_cache.rs:41-55, 110-170`). V8's compiled code is cached by the module's sha256 (`:50-55`).
- **A push sends the runners nothing.** A request at a newer timestamp reads the new module rows.
- Each request runs in a fresh context; isolates are reused across requests of one deployment and recreated on a
  client change, an unclean heap, 600 s idle or 3 600 s of age (`client.rs:1536-1610, 1669-1698`; knobs
  `REUSE_ISOLATES`, `ISOLATE_IDLE_TIMEOUT`, `ISOLATE_MAX_LIFETIME`, `knobs.rs:1043-1051`).

### 1.5 Scheduling, limits and timeouts

- `IsolateClient` queues requests in a CoDel queue (`ISOLATE_QUEUE_SIZE` 2 000, idle and congested timeouts of
  2 000 and 200 ms, `knobs.rs:1005-1016`). Each request waits for a concurrency permit, or is rejected with
  `InitialPermitTimeout` (`client.rs:1263-1300`).
- Each isolate thread takes one request at a time over a channel of size 1 (`client.rs:1453`). Threads are created
  lazily up to `MAX_ISOLATE_WORKERS` (300, `knobs.rs:1018-1020`; bunvex's default is DV-574).
- What bounds a backend's concurrency is the application's limiters, 16 queries, 16 mutations and 64 actions
  (`application_function_runner/mod.rs:269-300`). bunvex has them (`packages/server/src/action-permits.ts`).
- User time: 1 s (`DATABASE_UDF_USER_TIMEOUT`, `knobs.rs:982-983`). System time: 15 s
  (`DATABASE_UDF_SYSTEM_TIMEOUT`, `:993-994`). Both are enforced in the runner, where the isolate is terminated.

### 1.6 Nested calls

- `ctx.runQuery` / `ctx.runMutation` in a query or mutation is the async syscall `1.0/runUdf` (`run_udf`,
  `crates/isolate/src/environment/udf/async_syscall.rs:629-790`). It runs **inside the runner**, never through the
  backend:
  - it checks the kinds a function may call (`:637-655`) and the depth (`MAX_REACTOR_CALL_DEPTH`, `:685-692`);
  - it takes the caller's transaction (`start_nested_udf`) and begins a subtransaction (`:694-702`);
  - it runs the callee, then commits the subtransaction, or rolls it back for a failed mutation (`:757-762`);
  - it puts the transaction back.
- Where the callee runs is a knob, `SUBFUNCTIONS_IN_SAME_ISOLATE` (false by default, `knobs.rs:1358-1361`):
  - **false**: another isolate thread of the same process, the transaction moved to it (`client.rs:634-681`,
    `udf_callback`);
  - **true**: the same isolate (`environment/udf/mod.rs:1193-1213`).

  Either way the transaction never leaves the process.
- A system error inside the callee is upgraded to `OperationalInternalServerError`, because the caller's
  transaction is lost (`async_syscall.rs:735-756`).

### 1.7 The outcome

- `FunctionFinalTransaction` (`lib.rs:154-190`) holds:
  - the begin timestamp;
  - the reads (`FunctionReads`: the `ReadSet`, its interval count and the user and system read sizes, `:192-212`);
  - the writes: one `PendingDocumentUpdate` per document, coalesced, each with its old document and timestamp and
    its new document (`:214-220`; `crates/common/src/document.rs:807-811`). There are no index updates;
  - rows read per table;
  - uploaded files.
- `ReadSet` is, per index, an `IntervalSet` of key intervals, plus the search queries (`crates/database/src/reads.rs:69-100`).
- `FunctionOutcome` (`outcome.proto:10-38`):
  - the result, as a "JSON packed value" or a `JsError` with its message, custom data and frames
    (`common.proto:69-74`);
  - the log lines;
  - the query journal;
  - whether the run read the time, the randomness or the identity;
  - the syscall trace, the memory used, the user time;
  - the audit log lines.
- Query and mutation log lines come back **with the outcome**. An action's and HTTP action's are streamed through
  the log line sender (`server.rs:416-478`).
- `FunctionUsageStats` are counters (`usage.proto:5-30`).
- A system error is an `anyhow` error carrying `ErrorMetadata` (code, short and long message, OCC info). Over gRPC it
  is the status details (`crates/pb/src/error_metadata.rs:163-185`, `errors.proto:25-47`).
- **Retention is checked after the run.** Queries and mutations run with no retention check. `validate_run_function_result`
  then checks the snapshot is still in retention, and only then may the result or the error surface
  (`server.rs:221-239`, `in_process_function_runner.rs:301-319`). Actions are checked while they run.

### 1.8 What the backend does with it

- `apply_function_runner_tx` (`transaction.rs:591-618`) checks the timestamp matches, merges the read set, and
  merges the writes (`merge_writes`, `:625-684`).
- `merge_writes` applies each document update through `apply_validated_write` (`:1255`). That **recomputes the index
  updates and the schema registry's** from the document, against the backend's registries
  (`index.begin_update`, `schema_registry.begin_update`, `:1277-1294`). A runner never sends index entries.
- **A query** (`cache/mod.rs:698-748`):
  - the result is checked against the returns validator on the backend;
  - the transaction becomes a `Token` (read set and timestamp, `crates/database/src/token.rs:17-20`);
  - the token is cached with the result, and refreshed against the write log on a hit (`refresh_token`,
    `cache/mod.rs:770-800`).
- **A sync subscription** subscribes that token (`crates/sync/src/worker.rs:1202`,
  `crates/database/src/subscription.rs:144-147`).
- **A mutation** (`run_mutation_inner`, `application_function_runner/mod.rs:1268-1347`):
  - checks the write throughput limit;
  - validates the path and arguments, runs, sends the audit lines and checks the result;
  - is committed by the caller's retry loop (`_retry_mutation`, `:956-1210`). OCC is found by the one committer
    (`committer.rs:912-929, 1038-1041`). The loop retries an OCC error with backoff, up to
    `UDF_EXECUTOR_OCC_MAX_RETRIES` (4, `knobs.rs:321-322`), each retry a new call to the runner at a new timestamp.

### 1.9 Actions and the wire

- An action holds no transaction. What its `ctx` does that touches the deployment goes back to the backend through
  `ActionCallbacks` (`crates/udf/src/action_callbacks.rs:30-135`):
  - `execute_query`, `execute_mutation` and `execute_action`;
  - the storage calls;
  - `schedule_job` and `cancel_job`;
  - `vector_search`;
  - function handles.

  `fetch` runs in the runner.
- An HTTP action's response streams back part by part. The runner is cancelled when the client goes
  (`in_process_function_runner.rs:171-231`).
- What crosses a process in Convex Cloud, as the open protos show it:
  - **values** as JSON bytes;
  - **document updates** as ids, creation times and value bytes, with the old document's timestamp
    (`common.proto:28-62`);
  - **key intervals** as start bytes and an exclusive end or "after all" (`common.proto:179-185`);
  - **errors** as `ErrorMetadata` with `OccInfo` (`errors.proto`).

  Plain data, no object graphs.

## 2. What an app can observe

Nothing beyond latency and capacity, provided that each of these holds:

| Edge | Holds when |
|---|---|
| Answers and errors | the worker runs the same body on the same snapshot with the same metadata; errors cross with their class, name, message, data and the app's frames (STUDY-150, STUDY-171 §8.3) |
| Snapshot isolation | a worker reads exactly at the timestamp the main thread chose, through a connection that sees every commit up to it (§4.6) |
| Serializability | OCC stays in the main thread's one committer, against the full read set (§4.10) |
| Reactivity | the read set crosses whole, so a subscription is invalidated exactly as today (§4.5) |
| Module-level state | per code version and per worker: DV-573, decided |
| Log lines | a call's lines come back in its order, with its result; lines of different calls interleave by completion, as they do today between concurrent calls |
| Usage counters, `function_execution` fields | counted in the worker, summed on the main thread (§4.5) |
| `Date.now()` and `_creationTime` | the main thread fixes a call's start at dispatch, as today; mutations running at once on two workers may hand out creation times in the same millisecond, as on Convex (§4.10) |
| Limits | user time is measured in the worker as today. A function that never yields stops its worker (§4.12): it is terminated as Convex terminates its isolate, where under `vm` today it blocks the server |
| A push | a call runs the version that was live when it was dispatched, as today (§4.8) |

## 3. How bunvex does it today

One thread. A query or mutation is a closure, `TxBody = (db: Tx) => …` (`packages/core/src/engine.ts:284`), built
by `Functions` and run by the `Engine` in a `Tx`.

| Step | Query | Mutation | Where |
|---|---|---|---|
| Entry | `runQuery` / `runQueryJson` / `runQueryAtJson`, a sync session's query | `runMutationWithTs`, `runSessionMutation` | `packages/server/src/functions.ts:2755-2921`, `sync.ts:836-860` |
| Function log, tracing span | `logged` / `loggedRun` | same | `functions.ts:1224-1250` |
| Cache lookup | `cachedQuery` → `stillValid` (`committer.changedBetween`) | — | `engine.ts:3779-3898` |
| Timestamp | `committer.visibleTs`, or the requested one | `visibleTs`, each attempt | `engine.ts:3786-3787, 4095` |
| `Tx` | `execute`: `new Tx(this.catalog, this.persistence, snapshot, …)`, with the engine's retention, index cache, cursor codec, search and vector indexes, table counts; a mutation also gets the validators of the active, pending and staged schemas; `transactionStart` fixes `now` | same | `engine.ts:3670-3736` |
| Run state, path, arguments | `failWhileNotRunning` (read in the `Tx`), `fn`, `checkArgs`, `txEnv` | same | `functions.ts:1929-1977` |
| Permit | `limits.query.run`, after the checks | `limits.mutation.run`, per attempt | `functions.ts:1940, 1967` |
| Handler | `invoke` builds `ctx` (`db`, `auth`, `storage`, `scheduler`, `rooms`, `runQuery`/`runMutation` at `depth + 1`, `meta`), under the user timer, with audit lines collected | same | `functions.ts:2055-2100` |
| Result checks | `checkReturns`, the limit warnings, `hasCommitTs` refused in a query | `mustBeValue` | `functions.ts:1885-1977` |
| Reads | `Tx.reads`: `Interval[]` (`{ index, lo, hi }`, keys as bytes), plus `searchReads` | same | `tx.ts:451-480`, `committer.ts:27` |
| Writes | — | `Tx.toWrites()`: `DocWrite[]` (JSON text, `prevTs`) and the index entries, computed with the catalog the `Tx` began with | `tx.ts:2400-2430` |
| Commit | — | `committer.commit({ snapshot, reads, docs, idx, source, search…, atTs })`: OCC against the write log, the ts, the group flush (the SQLite writer thread since #878) | `engine.ts:4095-4150`, `committer.ts:485` |
| Retries | — | `attempts`: `ConflictError` retried with Convex's backoff, then `OccError` | `engine.ts:4069-4166` |
| After the commit | the result cached with its reads (`runCached`); a subscription registers the reads in `ReadSetIndex` | created tables added to the catalog, `afterCommit` callbacks (rooms), `onVisible` (search and vector indexes, table summaries) | `engine.ts:3826-3875, 4129-4150, 1260-1286`; `sync.ts:421, 623` |
| Logs | captured per call (`AsyncLocalStorage`, `logs.ts`), returned with the result, written to the function log by `loggedRun` | same | `packages/server/src/logs.ts` |

What the body reads from the main thread's memory, and so what a worker needs (§4.7, §4.11):

- **Metadata:**
  - the catalog (tables and indexes, their states and numbers);
  - the schemas' validators (active, pending, staged; per component);
  - the component tree;
  - the environment variables (read through the `Tx`, but cached in memory);
  - the code version's functions.
- **Services:**
  - text search and vector indexes (in memory, STUDY-45 and STUDY-51);
  - table counts (`tableSummaries`, STUDY-107);
  - the index cache (validated against the write log, STUDY-136);
  - the retention window (`retention.minIndexTs`);
  - the instance secret's derived keys (cursors, storage tokens);
  - the log streams (audit lines);
  - rooms (after-commit broadcasts).

## 4. The protocol

### 4.1 Principles

1. **The worker runs today's body.** Everything `queryBodyOf` and `mutationBody` do runs in the worker, on a `Tx`
   the worker builds. That is:
   - the run state;
   - the path, the arguments and the environment;
   - the handler and its nested calls;
   - the result checks and the warnings;
   - a session mutation's record.

   The main thread does not re-check what the worker checked: the answers are the same function of the same
   inputs.
2. **The main thread keeps today's engine around the body:**
   - the function log and the spans;
   - the query cache;
   - the permits;
   - the commit and its OCC, the retries;
   - the subscriptions and the after-commit work.
3. **Only data crosses.** Every message is one string. Values travel as the value JSON text
   (`toJsonValue`/`fromJsonValue`). Keys and other bytes travel one character per byte, as #878's wire. No object
   graph is structured-cloned (§4.2).
4. **Transport-agnostic.** The messages are framed by the transport:
   - a Worker's `postMessage` carries one message per string;
   - a socket to a follower process (STUDY-24 A2) carries STUDY-171 §7.2's frames: a 4-byte length, then the
     body.

   Nothing in a message refers to shared memory or to a thread.
5. **The in-thread executor stays**, as the reference for a differential test and for the stores a worker cannot
   open (§4.14).

### 4.2 Encoding, measured

`bench/offthread/outcome-wire.ts` measures what an outcome costs the **main** thread to receive and decode into the
committer's types (`Interval[]`, `DocWrite[]`, `LoggedIndexWrite[]`):

- three outcomes: a 20-document query result (6 intervals), a one-write mutation (5 index entries), a 20-write
  mutation (100 index entries);
- five encodings:
  - **clone**: structured clone;
  - **text**: #878's length-prefixed fields;
  - **text, docs passed on**: the document writes one opaque field, not decoded on the main thread;
  - **buffer**: one transferred `ArrayBuffer`;
  - **hybrid**: text, plus one transferred buffer for the keys.

Mac M1 Pro, shared and loaded (load average 17–23: ratios only), two runs
([results](../../bench/offthread/results/mac/outcome-wire.md)). µs per outcome on the main thread, with 64 in
flight:

| outcome | clone | text | text, docs passed on | buffer | hybrid |
|---|---:|---:|---:|---:|---:|
| query, 20 docs | 6.1–6.5 | 3.7 (11.0 once) | 3.6–4.5 | 3.8–4.4 | 4.1–4.9 |
| mutation, 1 write | 9.3–9.4 | 5.3–5.6 | 4.9–5.2 | 4.9–5.3 | 5.5 (9.2 once) |
| mutation, 20 writes | 67–70 | 44–53 | 40–42 | 47–48 | 39–42 |

- **Structured clone costs 1.5–2×**, as STUDY-190 §4.0 found.
- **The four flat encodings are within the noise of each other** for the common outcomes (4–6 µs). That is 1–2 %
  of the 250–450 µs a worker takes off the main thread per call (STUDY-190 §4.5).
- What costs at 20 writes is building 100 index-entry objects (about 0.3 µs each), whatever the encoding.
  - Not decoding the document writes saves about a quarter. For SQLite the main thread can hand that segment to the
    writer thread as it is: it is already #878's `encodeCommit` format, less the timestamp.
- **Choice:** one text format, #878's `WireWriter` fields, for every message:
  - one codec, and it is already in the product;
  - a socket carries it unchanged;
  - the document writes are kept as an opaque segment in the writer's format.

  A buffer for the keys alone is the fallback if a profile of PR 3 shows key decoding; this prototype says it would
  not pay now.

### 4.3 Messages

Main → worker:

| Message | Carries | When |
|---|---|---|
| `init` | the store's driver and its open options (path or URL, pool size), the instance name, the derived keys a body uses (cursor sealing, storage tokens), the knobs a body reads (user and system timeouts, limits), the protocol version | once, at the worker's start; the worker answers `ready` or `failed` |
| `epoch` | one metadata object by kind and number: `catalog` (per namespace), `schemas`, `components`, `env` (§4.7) | before the first `call` that names it, on the same channel |
| `version` | a code version: its id and its modules' sources (the app's and each component instance's), the load options (§4.8) | once per version per worker, before a `call` that names it |
| `release` | a version no call will name again | after a push, once the old version is idle |
| `call` | the request (§4.4) | per attempt |
| `answer` | the answer to an `op` the worker asked (§4.11) | per op |
| `cancel` | a call id | when the caller gives up (§4.12) |
| `close` | — | at shutdown: the worker ends its calls, closes its connection and exits |

Worker → main:

| Message | Carries | When |
|---|---|---|
| `ready` / `failed` | the protocol version / why it could not open its store or load | once |
| `op` | a call id, an op id, what the body needs from the main thread (§4.11) | during a call |
| `lines` | a call id, log lines | an action's and HTTP action's lines as they are written, as Convex streams them (§1.7); a query's and mutation's come with the outcome |
| `chunk` | a call id, a stream id, bytes | an HTTP action's response body, storage bytes (STUDY-171 §12.4's credit-controlled chunks) |
| `outcome` | the outcome (§4.5) | once per call |
| `alive` | the number of calls in flight | each time the worker's event loop turns, at most every 100 ms (§4.12) |

Every message begins with its kind and the call id where it has one, as #878's messages do (`<op><id>:`).

### 4.4 The request

| Field | Today's source | Notes |
|---|---|---|
| `id` | — | unique per worker |
| `kind` | query, mutation, action, HTTP action | an attempt of a mutation is a new `call` |
| `name` | the path, or a component's registry name | resolved in the worker, in its `Tx`, as today; a component path from the sync protocol is resolved there too (`sync.ts:846-856`) |
| `args` | the arguments, as value JSON text | the bytes the client sent are already JSON: the main thread does not decode them for a call it dispatches |
| `fromClient`, `visibility` | `fromClient` | internal functions refused in the worker, as today |
| `caller` | identity (its JSON), `systemIdentity`, the request's id, IP, user agent, scheduled job | `Caller` and `CallRequest` (`engine.ts:348-366`) |
| `ts` | `visibleTs`, or the requested ts | the snapshot (§4.6) |
| `now` | `transactionStart(ts)` | the call's first `_creationTime` and `Date.now()` (§4.10) |
| `minTs` | `retention.minIndexTs` | the worker fails a read below it early; the main thread checks again after (§4.6) |
| `version` | the live code version's id | §4.8 |
| `epochs` | catalog, schemas, components, env | §4.7 |
| `journal` | a subscription's `endCursor` | reactive pagination |
| `session` | a session mutation's `(sessionId, requestId)` | the worker reads and writes the record in the same `Tx`, as `sessionMutation` does |
| `deadline` | a sync mutation's | checked in the body, and again on the main thread before the commit |
| `trace` | the parent span's context | spans made in the worker come back in the outcome (AD-26) |

### 4.5 The outcome

| Field | Query | Mutation | Action |
|---|---|---|---|
| `ok` and `result` | the result as value JSON text, or the error (STUDY-171 §8.3's codec: class, name, message, data, the app's frames) | same | same |
| `lines` | the log lines | same | streamed (`lines`) |
| `audit` | the `log.audit` lines, resolved on the main thread with the request's variables (`emitAudit`) | same | same |
| `reads` | the read set: per index, its intervals `[lo, hi)` | same, plus `searchReads` | — |
| `observed` | time, identity | same | — |
| `journal` | `endCursor` | — | — |
| `writes` | — | the document writes (an opaque segment in #878's `encodeCommit` format, without the ts), the index entries (`index`, `key`, `table`, `id`, `docId`), the commit-timestamp paths per document (STUDY-53), the tables created, the catalog touches | — |
| `derived` | — | per write to a table with a text or vector index or a summary: what `onVisible` needs (§4.10) | — |
| `effects` | — | the after-commit callbacks as data (rooms broadcasts) | — |
| `counters` | documents and bytes read, user time, the limit warnings' inputs, rows read per table | plus documents and bytes written | plus egress |
| `creation` | — | the last `_creationTime` handed out | — |
| `spans` | the worker's spans, if traced | same | same |

- An error outcome carries its reads too: a subscription re-runs a failed query when its reads change
  (`queryTracked`, `engine.ts:3905-3968`).
- The main thread parses `result` only where it needs the value:
  - the HTTP API and the sync protocol send the text as it is;
  - a commit timestamp to resolve, or an in-process caller (`runQuery`), parses it.

### 4.6 The snapshot

- **The timestamp is the main thread's.** It picks `ts` exactly as today and sends it. The worker never reads newer
  (STUDY-24 A2's measured failure, a lagged snapshot, cannot happen: there is no lag).
- **Each worker reads through its own connection:**
  - **SQLite:** a read-only connection in WAL mode, as STUDY-190 (b) prototyped. A commit is published (`visibleTs`)
    only after the writer thread committed it. A read transaction the worker begins after it receives `call` sees
    every commit up to `ts`, and the store keeps every version by timestamp, so it reads `≤ ts`.
  - **Postgres, MySQL:** a pool of the worker's own (Q6). Reads are by timestamp as today. Every commit up to `ts`
    is durable before `ts` is visible.
  - **MongoDB:** the same, its own client.
  - **Memory:** no worker can open it; that store runs in-thread (§4.14).
- **Retention,** as Convex (§1.7):
  - the request carries `minTs`, and the worker fails a read below it early, as `Tx` does today;
  - after the outcome, the main thread checks `ts ≥ retention.minIndexTs`, which only moves forward and is persisted
    before anything is deleted (`retention.ts`);
  - if the window passed `ts` during the run, the outcome is replaced by `OutOfRetentionError`, whatever it was.

  That is Convex's `validate_run_function_result`, for queries and mutations.
- **Table counts and search** stay on the main thread (§4.11). A count is answered at `ts`, as `tableSummaries`
  answers it today for a pinned snapshot. The worker's call pins it: the main thread pins `ts` at dispatch and
  unpins at the outcome.

### 4.7 Metadata: by epoch, from the main thread

- Today a `Tx` takes the catalog object current when it begins (`engine.ts:3685`), not one rebuilt at its snapshot.
  So does the schema state.
- To give a worker exactly that, the main thread numbers each metadata object when it replaces it (an epoch). The
  request names the epochs it was dispatched with. A worker that lacks one gets it in an `epoch` message posted
  before the `call` on the same channel, which keeps message order. The worker keeps the last few of each kind.
- This is STUDY-171 §8.4's design for the `process` executor (`EpochWindow`), taken as it is.
- Convex instead rebuilds each registry from the store at the request's timestamp, cached by the system indexes'
  last-modified timestamps (§1.3). Both are safe for the same reason: a transaction records reads of its tables'
  `_tables` rows and of `_schemas.by_state` (`Tx.dependOn`, `readSchemas`, `tx.ts:832-870`). A commit that changes
  either conflicts with a mutation, or invalidates a query, that used the older one. Q2 asks which to build.

### 4.8 Code versions

- Today a call runs the live version, switched atomically at a push (`installCodeVersion`, `server.ts:2332-2345`,
  DV-164). A worker must do the same.
- The request carries the live version's id at dispatch. A worker that lacks it gets a `version` message first,
  with the sources the main thread already holds, and loads it with the same loader (`CodeVersion.load`, through
  `loadCode`).
- **A push:**
  1. the main thread loads and analyzes the new version, as today;
  2. it posts `version` to every live worker before it switches (a preload, so the first call does not wait on a
     load);
  3. it switches; calls dispatched before the switch keep the old id;
  4. once no call in flight names the old version, it posts `release`.

  A worker started later loads only the live version.
- **Module state** is per version and per worker (DV-573). A component instance's code is loaded beside the app's
  version, as `process` does it (STUDY-171 §15).
- **What the main thread keeps loading:**
  - the push's analysis and evaluations (`evaluateDefault`);
  - crons, the HTTP router, the function list;
  - the in-thread reference executor;
  - `_system/` functions, which run on the main thread (§4.14).

### 4.9 Nested calls

- `ctx.runQuery` / `ctx.runMutation` in a query or mutation run **on the caller's worker, in its `Tx`**, through
  today's `nestedCalls` (savepoint, depth, a failed mutation rolled back). Nothing crosses.
- That is Convex's `SUBFUNCTIONS_IN_SAME_ISOLATE=true` shape. Convex's default runs the callee on another isolate
  thread of the same process, with the transaction moved to it. The two are equivalent to an app: the callee runs
  in the caller's transaction either way.
- An action's `ctx.runQuery` / `runMutation` / `runAction` is different: it is a new top-level call, as Convex's
  `ActionCallbacks` (§1.9). It is an `op` to the main thread, which runs it with its own permit, its own cache
  lookup and its own dispatch, possibly to the same worker (§4.11).

### 4.10 The commit

The main thread receives a mutation's outcome and does what `attempts` does today:

1. **Deadline and retention checks** (§4.4, §4.6).
2. **No writes:** the result is returned at `ts`, and the after-commit effects run.
3. **The committer:**
   - it takes `{ snapshot: ts, reads, docs, idx, source, searchReads, searchDocs, logExtra: catalog touches }` from
     the outcome;
   - OCC is checked against the write log as today;
   - the documents' segment goes to the SQLite writer thread as it is (Postgres, MySQL and MongoDB decode it for
     their driver).
4. **A conflict** (`ConflictError`): the main thread backs off, waits for the conflicting write to be visible, and
   dispatches a **new attempt** (a new `call` at a new `ts`, to any worker). These are STUDY-24 A2's "retries run on
   the leader", and Convex's `_retry_mutation`.
5. **A commit timestamp** (`db.vars.commitTs`, STUDY-53), a rare path:
   - the outcome lists, per document, the paths that hold the placeholder;
   - at `atTs`, the main thread decodes those documents, sets the timestamp, re-encodes them and recomputes their
     index keys with its catalog;
   - it resolves the result's placeholder the same way.

   Today this is `Tx.resolveCommitTs` on the same objects.
6. **After the commit:**
   - the created tables are added to the catalog;
   - the effects run in order (rooms);
   - `onVisible` applies the derived data to the search and vector indexes and to the table summaries;
   - `creation` updates the engine's creation cursor.

**Index entries.** The worker computes them, as `Tx.toWrites` does today, with the catalog epoch it ran with. A
catalog change between `ts` and the commit is a conflict, through the `_tables` reads every `Tx` records and the
catalog touches every index change writes (`tx.ts:832-893`). Convex and STUDY-24's sketch recompute them on the
backend from the documents instead (§1.8). Doing that here would put a `JSON.parse` and the key encoding of every
written document back on the main thread, the work this plan moves off. Q1 asks.

**Derived data.**
- What `onVisible` does today needs the written documents as objects:
  - the search indexes' tokens and filter keys (`searchIndexes.commitWrites`);
  - the vector indexes;
  - the table summaries' counts, sizes and shapes (`table-summaries.ts:158-210`).
- The worker computes the search and vector parts and sends them as data. The table summaries need the documents
  themselves, for shapes: the main thread keeps the documents' JSON text and parses it when the summaries fold,
  which is already deferred (`setImmediate`, `FOLD_AFTER`).
- PR 3 measures this. If the fold shows in the profile, the worker can send each document's shape instead.

**Creation times.**
- Today `transactionStart` keeps a transaction's first `_creationTime` past the previous transaction's start and
  past the creation times the last mutation handed out (`engine.ts:3665-3674`). Interleaved mutations on one thread
  see each other's cursor; mutations on two workers do not.
- The main thread still fixes `now` at dispatch, past every cursor an outcome reported. Two mutations running at
  once may then hand out creation times in the same millisecond.
- Convex has no ordering across transactions here either (`CreationTime::for_transaction`, §1.3). It is not a
  divergence from Convex.

### 4.11 Ops: what a worker asks of the main thread

The worker sends `op` messages for state only the main thread has, and waits for the `answer`:

| Op | From | Today | Notes |
|---|---|---|---|
| `count` | `count()` in a query or mutation | `tableSummaries` at a pinned ts | answered at the call's `ts`, plus the `Tx`'s own count changes, which the worker applies |
| `search` | `withSearchIndex` | `searchIndexes` (memory part and segments) | the index, the query, the filters and `ts`, plus the `Tx`'s own writes to that table; answers ranked ids and scores |
| `runQuery`, `runMutation`, `runAction` | an action | `Functions.run*` with the action's caller | top-level calls on the main thread, with permits; Convex's `execute_*` callbacks |
| `schedule`, `cancel` | an action's `ctx.scheduler` | a mutation of its own | Convex's `schedule_job`, `cancel_job` |
| `storage.*` | an action's `ctx.storage` | the storage API | bytes as `chunk` frames; Convex's `storage_*` callbacks |
| `vectorSearch` | an action | `vectorIndexes` | Convex's `vector_search` |
| `functionHandle` | an action | `createFunctionHandle` | Convex's function handle callbacks |
| `rooms.*` | an action's `ctx.rooms` | the rooms hub (AD-42) | a mutation's broadcasts are `effects` instead |

- A query's or mutation's `ctx.storage`, `ctx.scheduler` and function handles are writes in its `Tx`, as today. They
  stay in the worker.
- `fetch` runs in the worker, with the main thread's screening settings sent at `init` (STUDY-80, STUDY-142).

### 4.12 Cancellation, timeouts, failures

- **Cancel.** `cancel(id)` aborts the call at its next `await`, as `untilAborted` does today. It is sent when:
  - an HTTP action's client goes (Convex cancels it, §1.9);
  - a sync mutation's deadline passes;
  - an action is cut off (STUDY-77).

  An outcome that arrives after a cancel is dropped: a mutation's is never committed.
- **User time** is measured in the worker by today's timer.
- **A function that never yields.** The main thread watches each worker's `alive` messages. A worker with calls in
  flight that has been silent for the longest remaining user time of those calls, plus a slack (STUDY-171 §8.5:
  50 ms), is stuck:
  - the main thread terminates it;
  - the stuck call fails with Convex's timeout message;
  - its other calls fail as system errors (as under `process`).
- **A worker's death,** or a message that does not parse: the worker is never used again.
  - Every call in flight on it fails with a system error.
  - Its mutations had not committed: a mutation commits only on the main thread, after its outcome.
  - The next call starts a new worker.
  - The store is not involved, so nothing durable is in doubt. This differs from #878's writer thread, whose death
    leaves writes in doubt and stops the committer (fail-stop).
  - Q3 asks whether the server should rather stop.
- **A worker that cannot open its store** (`failed` at `init`) fails the call that started it. The pool backs off
  before trying again. The cause is logged once per minute.

### 4.13 Backpressure and dispatch

- **Permits stay on the main thread,** before dispatch: Convex's 16 queries, 16 mutations, 64 actions
  (`action-permits.ts`). A cache hit and a nested call take none, as today.
- Before PR 2a a call took its permit after its path and arguments were checked, in its transaction. Convex at
  `bb31399` does that for a query only (§1.2). With workers the check would run in the worker, after the permit, so:
  - **a query:** the main thread checks the path, the visibility and the arguments first, with the live version's
    validators it already holds, then takes the permit. That is Convex's place for that check. The runner does not
    check the same text again;
  - **a client's mutation:** the permit comes first, before the attempt's transaction, and the runner checks the
    arguments under it, as Convex's d328f85 (STUDY-186 A11). The main thread resolves only the path and the caller's
    access, which need the caller's admin key. Scheduled and cron mutations keep their order.
- **Workers are created lazily** up to `MAX_ISOLATE_WORKERS`, by default the core count (DV-574). A call goes to the
  worker with the fewest calls in flight. A new worker is started when every worker has at least one call and the
  cap is not reached.
- A worker runs many calls at once, interleaved at their `await`s, as the main thread does today. So the worker
  count bounds CPU parallelism, not concurrency. An action waiting on `fetch` holds no thread, and an action's
  nested query never waits for a free worker: no deadlock.
- There is no queue in the workers beyond what the permits admit. The main thread's own work (HTTP, the cache,
  commits) is never blocked on a worker.

### 4.14 What stays on the main thread

- The engine's own transactions: `_system/` functions, crons' bookkeeping, imports, exports, retention, backfills,
  pushes. They are closures over the engine and run in-thread, as today.
- Everything on the memory store, and embedded servers whose store object was handed in rather than configured: no
  worker can open those.
- The in-thread executor: the same request and outcome types, without serialization. It is the reference for the
  differential test (§6) and the executor when `MAX_ISOLATE_WORKERS` allows none (Q4).

### 4.15 The same protocol to a follower process

- Over a socket the messages are the same strings, in STUDY-171 §7.2's frames: a 4-byte length first, and a cap
  checked before the body is read.
- What a follower adds is outside this protocol:
  - its own HTTP;
  - its connection to the leader;
  - the lease.
- The snapshot rules hold unchanged, because a follower reads the shared store at the leader's timestamp
  (STUDY-24 A2).
- Two things in this design are for threads only:
  - the main thread's pins of `ts` for table counts (a follower asks `count` as an `op` all the same);
  - the documents' segment handed to the SQLite writer thread (a follower's leader decodes or forwards it the same
    way).

## 5. Divergences

None proposed. Each edge of §2 matches Convex or today's bunvex:

- **Module state per worker** is DV-573, decided.
- **The never-yielding function** is stopped, as on Convex. Today's `vm` blocks the server, so this moves bunvex
  toward Convex.
- **Creation times of concurrent mutations** may share a millisecond, as on Convex.
- **The order of the path and argument check and the permit** is kept (§4.13).

## 5b. Additions (beyond Convex)

None needed by an app. Q4 (owner, 2026-10-26): `MAX_ISOLATE_WORKERS=0` runs functions on the main thread, a
meaning Convex's knob does not have, recorded as AD-47; tests choose with a `createServer` option, and the memory
store and handed-in stores run in-thread automatically.

## 6. PR plan

STUDY-190's PRs 2–4, refined. Each PR keeps PERSIST-01 conformance and every suite green. Each has a sabotage check
(break the fix, watch the test fail) and a measurement on DigitalOcean `c-4` server and load boxes in `sfo2`:

```
RUN=<name> SERVER_SIZE=c-4 LOAD_SIZE=c-4 REGION=sfo2 SCENARIOS=<…> bun bench/cloud/cloud.ts all single
```

The baseline is the same box's run without the PR.

| # | PR | Tests | Measurement |
|---|---|---|---|
| 2a | **The call boundary, in-thread.** `CallRequest` / `CallOutcome` (§4.4, §4.5) and the codec (§4.2). The body runner, which a worker will host, is split from the main thread's dispatcher; every main-only service is reached through one interface (§4.11). The permit moves after a main-thread path and argument check (§4.13). The in-thread executor runs every query and mutation through the boundary, **with** the codec (encode, then decode), so every suite exercises it: under the tests only (Q7); otherwise the same objects cross without it. No worker yet. | the whole suite under the round-tripping executor; a codec property test (any value, read set and write set round-trips; a malformed message is refused with its path); sabotage: drop one interval in the codec, and the OCC and invalidation suites fail | `uncached`, `insert` on SQLite: no regression beyond 3 % |
| 2b | **Query workers.** The worker runtime: `init`, epochs, versions, `call`, `count` and `search` ops, `alive`, `cancel`. Its store connection: SQLite read-only, or its own Postgres, MySQL or MongoDB pool (Q6). Lazy creation up to `MAX_ISOLATE_WORKERS`, dispatch by load, the retention check after the run, worker death and stuck workers (§4.12). | **differential, in-thread vs workers**: every query of the examples and of the server's fixtures, and generated queries (STUDY-122's generator), compared on the result text, the error (class, message, data, frames), the log lines and the read set interval by interval; **snapshot isolation**: a query held in a worker across a concurrent commit returns the old snapshot, and its read set invalidates it; **pushes under load**: queries in flight across a push answer from the version they were dispatched with, none fails; **retention**: a run whose `ts` falls out of the window mid-run fails with `OutOfRetention`; **death**: a worker killed mid-call fails its calls as system errors and the next call succeeds; **stuck**: `for (;;) {}` times out and the server answers others meanwhile | `uncached`, `cached`, `mix` on SQLite and Postgres. Expected uncached 1.6–2× on `c-4` (STUDY-190 §4.5's ceiling). The main thread's profile (`bench/offthread/profile.ts`) should show the values and transaction work gone |
| 2c | **Only if 2b's profile shows store reads in the workers:** an index cache per worker, fed by the commit stream (each commit's index-key writes, what STUDY-24 §4.3 says a follower needs), validated as STUDY-136's against that stream (Q5) | the index cache's own tests run in a worker; a stale-entry sabotage caught by the differential test | `uncached` against 2b |
| 3 | **Mutation workers.** Writes in the outcome; the documents' segment handed to the SQLite writer; commit timestamps resolved on the main thread; created tables, effects, derived data, the creation cursor; session mutations; retries as new attempts (§4.10) | the differential test extended to mutations: the same documents, index entries (byte for byte), result and lines; **serializability**: STUDY-57's history checker over concurrent bank transfers and counters, with and without workers; **OCC**: a hot key (`increment1`) gives the same conflict messages and retry counts as in-thread; **commit timestamps**: STUDY-53's suite under workers; **death**: a worker killed after its outcome is sent but before the commit commits once, and one killed before it commits nothing; a sabotage that commits an outcome after a cancel is caught | `insert`, `increment1000`, `increment1` on SQLite and Postgres, against PR 1's numbers |
| 4 | **Actions and HTTP actions.** The action `op`s (Convex's `ActionCallbacks`), `fetch` in the worker, lines streamed, HTTP bodies and storage bytes as chunks, the cut-off (STUDY-77), cancel on a client's disconnect | the action parity suite (STUDY-171 §12.7's cases) under workers; a client that disconnects cancels its HTTP action; an action's nested query on a saturated pool does not deadlock | the `action` scenario |

STUDY-190's PR 5 (HTTP front threads) follows, unchanged.

## 7. Tests (summary)

- **Differential:** one generator, two executors (in-thread and workers), compared field by field:
  - answers and errors;
  - log lines;
  - read sets;
  - a mutation's writes.

  This is the main guard, and it runs in CI on SQLite and Postgres.
- **Concurrency:**
  - snapshot isolation across a commit;
  - serializability by STUDY-57's checker;
  - a push under load.
- **Failure:**
  - worker death before and after the outcome;
  - a stuck worker;
  - a store a worker cannot open;
  - retention passing a running call;
  - a malformed message.

## 8. Owner questions

Q1–Q6 decided by the owner on 2026-10-26, as recommended; Q7 on 2026-10-27, option 2 (as recommended).

| # | Question | Recommendation |
|---|---|---|
| Q1 | **Index entries:** the worker computes them with the catalog it ran with, and OCC on the catalog rows covers a change (§4.10)? Or the main thread recomputes them from the documents, as Convex's backend and STUDY-24's A2 sketch do? | **The worker.** It is what `Tx.toWrites` does today, and the catalog touches already make a stale catalog a conflict. Recomputing puts a parse and the key encoding of every written document back on the main thread. Not observable either way |
| Q2 | **Metadata:** sent by the main thread by epoch (STUDY-171's design, §4.7)? Or rebuilt by each worker from the store at `ts`, cached by last-modified timestamps (Convex's funrun, §1.3)? | **By epoch.** A worker then runs on exactly the metadata an in-thread call uses today, which the differential test can hold it to; the main thread owns the catalog (index states, backfills). A follower process can take the same messages. Convex's way needs the catalog to be a pure function of the store at `ts`, which bunvex's is not yet |
| Q3 | **A worker's death or a stuck worker:** fail its calls and replace it, the server running on (§4.12)? Or stop the server, as #878 stops on its writer's death? | **Replace it.** An execution worker holds nothing durable: its mutations commit only on the main thread. Convex too recreates an isolate and fails its request. Deaths are logged and counted in `/metrics` |
| Q4 | **Choosing in-thread execution:** (a) `MAX_ISOLATE_WORKERS=0` means in the main thread, a bunvex meaning for Convex's knob (an addition, AD-47); (b) a bunvex knob of its own; (c) no operator setting, only a `createServer` option for tests, with the memory store and handed-in stores in-thread automatically? | **(a) with (c)'s option.** Convex's 0 admits no function at all, so the value is free. It gives operators a way back if a worker bug appears. Tests pick per server. Recorded as AD-47 |
| Q5 | **A worker's index cache** (PR 2c): build it only if PR 2b's profile shows store reads in the workers? It would be fed by the commit stream a follower also needs (STUDY-24 §4.3) | **Only if measured.** Convex's runners have none for user tables (their cache holds in-memory system indexes, §1.3). Without it a worker reads its own connection, on its own core |
| Q6 | **Store connections:** each worker opens its own pool. Keep the total within Convex's `POSTGRES_MAX_CONNECTIONS` / `MYSQL_MAX_CONNECTIONS` (128) by splitting it between the main thread and the worker cap? Or give each worker the full size? | **Split it.** The main thread keeps what its commits and system work need (a quarter, at least 8); the workers share the rest evenly up to the cap. No deployment opens more connections than it does today, and the knob keeps Convex's meaning as a process total. MongoDB's `POOL` the same way |
| Q7 | **The codec in the thread (PR 2a):** every in-thread call round-trips through the codec, as §6 asked, and costs uncached −15 % and insert −12 % on DO `c-4` (§9). Keep it so until workers replace it? Or round-trip only under tests (the suites keep exercising it), and pass the request and outcome as objects through the same boundary otherwise (−2 %), as §4.14 describes the in-thread executor? Or keep the codec and spend PR 2a on making it cheaper first? | **Decided (owner, 2026-10-27): option 2, round-trip under tests only.** Nothing an app observes differs: the types, the runner and the dispatcher are the same, and the differential test of PR 2b compares in-thread and workers on the decoded outcome. A Bun Worker pays a message per call anyway; the main thread does not need to pay it twice |

## 9. PR 2a, built (#895)

- **The boundary.** `core/src/call-wire.ts` holds `CallRequest`, `CallOutcome` and their codec (§4.2's format; a
  message that does not parse is refused naming the field, `MalformedCallMessageError`). `core/src/call-runner.ts`
  holds the runner and `CallHost`, the one interface to what only the main thread has (the store, the catalog,
  counts, search; its `begin`, `pin`, `finish`). `Engine.execute` dispatches a `Call` to it; the query cache, the
  subscriptions, OCC and the commit read the decoded outcome (its read set, search reads, writes, catalog touches,
  identity and time observed, journal, counters).
- **What crosses.** Every query and mutation a client calls (HTTP, sync, an action's `runQuery` / `runMutation`, a
  session mutation and its record) whose path and access pass on the main thread and whose arguments survive the
  text exactly. A `_system/` function, a standalone query, a room's gate, a component path from the sync protocol, a
  scheduled or cron mutation, and a call that fails the main thread's check run as bodies, in-thread, as before.
  Arguments cross as value JSON in the caller's field order (a top-level call keeps it).
- **What stays beside the outcome, for now** (`CallLocal`): the value an in-process caller gets and the error
  object (PR 2b moves errors to STUDY-171 §8.3's codec), the log lines (they still flow through the thread's log
  scope), and what a mutation's commit takes from its transaction (after-commit callbacks, derived search and
  summary data, created tables, commit timestamps: PR 3, §4.10).
- **Q7, built.** The root test preload (`test/preload.ts`) calls `roundTripCallsByDefault()`, so every engine of a
  `bun test` run round-trips its calls through the codec; `Engine`'s `callCodec` option sets it per engine. Outside
  the tests the dispatcher hands the runner the same `CallRequest` and gets the same `CallOutcome` back
  (`CallRunner.runRequest`), with the caller's identity and the arguments beside the request as they are. No
  environment knob. `core/test/call-boundary.test.ts` and `server/test/call-permits.test.ts` fail if a test run's
  engine does not round-trip; `server/test/call-no-codec.test.ts` runs a server without the codec.
- **Measured** on DO `c-4` (sfo2, Xeon Platinum 8168), SQLite, k6 32 VUs, 3 × 30 s per point, interleaved on the same
  droplets (`bench/results/cloud/2026-10-27-15-*`), against `main` `f3a17aa8`:
  - **as merged** (`bce3c564`, no codec outside the tests): uncached 2058 / 2016 req/s against 2026 / 2021 (+0.7 %),
    insert 2045 / 2065 against 2100 / 2104 (−2.2 %);
  - with Q7's switch but the arguments still crossing as text (`ddb23c73`): uncached −3.8 %, insert +0.9 %;
  - with the codec on every call (`2c68d478`, before Q7; `bench/results/cloud/2026-10-27-00-*`): uncached −15 %,
    insert −12 %; the boundary without the codec (`9e0345c1`, measurement only) −3 % and −2 %. An in-process
    micro-benchmark on the server box put the codec at about 45 µs a query and 55 µs an insert there, three to four
    times what it costs alone in a loop; that is why Q7 was asked.

## 10. PR 2b, planned (2026-10-27)

Read at `perf/exec-call-boundary` (#895) merged with `main` `873df0bf`. `F` is `packages/server/src/functions.ts`, `E`
is `packages/core/src/engine.ts`, `T` is `packages/core/src/tx.ts`.

### 10.1 What a worker needs to run a query's body

A query's body is `Functions.callBody` → `queryRun` (F:1977, F:2036) in a `Tx` begun by `Engine.beginTx`
(E:3839-3863). Where each input comes from in a worker:

| Input | Today | In a worker |
|---|---|---|
| The function, its component, module loads | `fnLater`, `componentOf`, `countStartReads` (F:2137, F:1136) | the `version` message: one registry per code version |
| Run state (`failWhileNotRunning`) | `BackendStateCache`, fed by commits (F:2152, `core/src/backend-state.ts`) | the request carries the state's last-write ts; the worker's cache reads its own store |
| Environment (`txEnv`) | `engine.environment.reader`, fed by commits (F:1149-1158) | as the run state: last-write ts in the request, rows from the worker's store; component env in `version` |
| Timeouts, size limits, `udf404OnBadPath` | `Functions` fields and knobs | `init` |
| Catalog, search-index state | `engine.catalog` (E:3839) | an `epoch` message |
| Document and index reads | `persistence.get` / `scan` (T:1320, T:1661) | the worker's own connection (§10.2) |
| `count()` | `tableCount`, synchronous (T:2500) | an op to the main thread, which pins `ts` at dispatch |
| Text search | `searchHits`, synchronous metadata and search (T:1042, T:2537-2598) | the metadata from the epoch; the search an op |
| Retention | `retention.minIndexTs` (E:3839) | `minTs` in the request; the main thread checks again after the run, as Convex (§10.3) |
| Cursor sealing, storage URLs | `cursorCodec` (E:906-913), `fileStorage.reader` | derived keys in `init` |
| Console lines, `log.audit` lines | thread scopes (`core/src/logs.ts:105`, `log-audit.ts:7`) | captured in the worker, carried in the outcome, replayed on the main thread (the sandbox's `captureLines` / `logChildLine`) |
| Errors | objects the dispatcher tests with `instanceof` (`errors.ts:49-62`) | STUDY-171 §8.3's codec, rebuilt by name on the main thread; stacks mapped in the worker, where the version's source maps are |
| The function log's figures | `tx.io()`, `tableStats`, `usage`, user time (F:1545-1555) | new outcome fields |

### 10.2 Store connections

- **SQLite.** The worker opens the file read-only, with its own page cache. It takes no lock, runs no DDL and starts
  no writer thread. It needs no read transaction: rows are versioned by ts, and `visibleTs` moves only after the
  writer thread committed (`committer.ts:770`). The read statements move out of `SqlitePersistence` into one module
  both sides use.
- **Postgres, MySQL, MongoDB.** Each driver gets a reader open that skips the bootstrap (DDL, the lease). Pools are
  sized when they open, so the split (Q6) is decided when the server opens its store.
- **A store opens in a worker only if it describes how** (`Persistence.reader()`). Wrappers (retries, timeouts, test
  stores) do not forward it, so they run in-thread.

### 10.3 Decided by matching Convex

- **The retention check after a run applies in-thread too.** Convex's `validate_run_function_result`
  (`crates/function_runner/src/server.rs:222-239`) checks the snapshot of every query and mutation after it ran, and
  its in-process runner calls it as well (`in_process_function_runner.rs:318`). A run whose window passed mid-way
  fails with `OutOfRetention` whichever executor ran it.
- **A query runs the code version its arguments were checked against.** 2a checks a query's arguments in
  `callSpec` (F:1955) and resolves its function again after the permit (F:1980): a push in between runs the new
  handler on arguments the old validator accepted. The fix binds the resolved function, and in 2b its version id,
  to the call. Its own PR, before 2b, with a test that pushes during the permit wait.
- **A worker's clock is its own, floored at its snapshot** (DV-121, owner, 2026-10-27). Convex's funrun begins its
  transaction with `CreationTime::for_transaction(ts, rt.generate_timestamp())`
  (`crates/function_runner/src/in_memory_indexes.rs:100`): the executor's wall clock, floored at the snapshot ts
  rounded up to a millisecond (`crates/common/src/document.rs:225`). `Date.now()` is derived from it
  (`server.rs:385`). So the request's `now` (§4.4) becomes that floor, and the worker takes the larger of it and
  its own clock. In one process the two clocks are one, and nothing changes. It matters for a follower process on
  another machine.

### 10.4 Run in-thread, not observable

These calls keep running in the main thread in 2b. None changes an answer: the in-thread executor is the reference
(§4.14).

- a store without a reader description (memory, `:memory:` SQLite, wrapped stores);
- the `process` sandbox (AD-44): its child is already off the thread;
- functions given with `register()` (embedded servers, `@bunvex/testing`), which have no sources to send;
- a server with a custom `Runtime` (virtual clocks in tests);
- calls with the system identity, and `_system/` functions (already in-thread in 2a);
- a call a sampler traces (AD-26), until spans cross in the outcome;
- a call made while no worker is ready yet (the first calls after a start or a push).

`cancel` stays for PR 4: no query in 2b has a sender for it.

### 10.5 Commits

Each one is green on its own. 0a–0d change nothing observable and run under the codec in the tests (Q7).

| # | Commit | Proof |
|---|---|---|
| 0a | `Tx.tableCount` and the search may be asynchronous | every suite; the count and search suites |
| 0b | the outcome carries errors, console and audit lines, the function log's figures; the retention check after a run (§10.3) | every suite through the codec; sabotage: the codec drops `BunvexError` data, or one line |
| 0c | `Functions` reaches the engine through a narrow `FunctionsHost`; one registry per code version; a code epoch | push and component suites |
| 0d | the catalog and search-state codec, and the epoch window (lifted from `packages/sandbox/src/host-call.ts`) | a property test; in tests the in-thread runner reads the catalog through the codec; sabotage: drop `staged` |
| i | the worker runtime: `init`, `ready`/`failed`, `alive`, `close`; lazy start up to `MAX_ISOLATE_WORKERS`; a dead or stuck worker replaced (Q3); the compiled binary's entry | kill and restart; a stuck worker terminated (first proving `Worker.terminate` stops a tight loop in Bun) |
| ii | the SQLite reader in a worker | PERSIST-01's reads through the worker; a commit after `ts` is invisible |
| iii | `version`, `release`, `epoch` | the worker's registry resolves as the main thread's for every example app |
| iv | queries dispatched to workers on SQLite; `count` and `search` ops | the differential test, in-thread vs workers, on result text, errors, lines and read sets interval by interval; snapshot isolation; a push under load; retention; death; stuck; sabotage: run at `visibleTs`, drop an interval |
| v | Postgres, MySQL and MongoDB readers; the connection split | the differential test on the Postgres job; connections counted in `pg_stat_activity` |
| vi | the profile and the DO `c-4` measurement | §6's 2b row |

### 10.6 Owner questions for 2b

Decided by the owner on 2026-10-27, as recommended.

| # | Question | Recommendation (decided) |
|---|---|---|
| Q8 | **The connection split (Q6) in numbers.** With MongoDB's pool of 16 the main thread keeps 8 and 16 workers would get half a connection each; and the split would shrink the main pool even when no worker can start. | Split only when workers can start (a store with a reader, `MAX_ISOLATE_WORKERS` > 0). The main thread keeps max(8, ⌊total/4⌋). The worker count is also capped so each has at least 2 connections (min(`MAX_ISOLATE_WORKERS`, cores, ⌊rest/2⌋)). Not observable but in capacity |
| Q9 | **SQLite's page cache per worker.** AD-46's 256 MiB is one connection's. N workers with their own would use N + 1 times the memory | Keep AD-46's value as the process total: the main thread keeps half, the workers share the other half. `BUNVEX_SQLITE_CACHE_SIZE` keeps its meaning as what the deployment spends |
| Q10 | **An embedded server on a SQLite file** (`createServer` with a path): workers too, or in-thread unless asked? | Workers, as `bunvex-local-backend`: the same store, the same knob. `createServer({ executionWorkers: 0 })` turns them off |
