# STUDY-41 — `ctx.runQuery` / `ctx.runMutation` in queries and mutations, and the 1 s execution limit

- **Status:** draft (N1–N6 await the owner)
- **Convex source read:** commit `4577b9031` of get-convex/convex-backend
- **Related:**
  - roadmap item 11 ([parity README](../parity/README.md));
  - [STUDY-06](STUDY-06-transactions-and-occ.md) (transactions);
  - [STUDY-03](STUDY-03-deterministic-execution.md) (determinism, DV-02: not a sandbox);
  - [STUDY-11](STUDY-11-function-results-and-errors.md) (errors and log lines).

## 1. How Convex does it

### 1.1 The API (`npm-packages/convex/src/server/registration.ts`, `impl/registration_impl.ts`)

**Which context has which call**
- `QueryCtx.runQuery(ref, args?, { transactionLimits? })`.
- `MutationCtx.runQuery(ref, args?, { transactionLimits?, useStaleSnapshot? })`.
- `MutationCtx.runMutation(ref, args?, { transactionLimits? })`.
- The reference may be public or internal.

**`useStaleSnapshot` from a query** throws at once: "`useStaleSnapshot` is only supported in mutations, not queries."

**The syscall**
- Every call is the syscall `1.0/runUdf` with `{ udfType: "query" | "snapshotQuery" | "mutation", name | reference | functionHandle, args, transactionLimits? }`.
- A rejection becomes `new Error(message)`, or a `ConvexError` with its `data`. Either way the parent can catch it.

### 1.2 Semantics (`crates/isolate/src/environment/udf/async_syscall.rs` `run_udf`, `crates/database/src/transaction.rs`)

**Which calls are allowed**
- A query may call a query.
- A mutation may call a query, a snapshot query or a mutation.
- Anything else is `InvalidFunctionCall`: "Cannot call a Mutation function from a Query function".

**Checks before the call**
- The path and the arguments are checked first, with any visibility allowed (internal functions are callable).
- The messages are the usual ones:
  - `ArgumentValidationError: …`;
  - "Trying to execute X as Query, but it is defined as Mutation.";
  - "Could not find public function for 'X'.".
- Then the depth: `MAX_REACTOR_CALL_DEPTH` = 8 nested levels below the top-level function. Past that, the error is "Cross component call depth limit exceeded. Do you have an infinite loop in your app?".
- All of these are catchable in the parent.

**One transaction**
- The nested function runs in the parent's transaction.
  - It sees the parent's uncommitted writes, and the parent sees its writes.
  - It has the same identity (`ctx.auth`) and the same timestamp (`Date.now()` base), and a random seed drawn from the parent's.
  - Its reads join the parent's read set, so a parent query re-runs when they change, and a parent mutation conflicts on them.
  - Usage counts (documents and bytes read and written) are shared.
- A nested **mutation** runs in a sub-transaction: `begin_subtransaction` nests the writes, the index entries, the metadata and the registries.
  - If it fails, its writes are rolled back. Its reads stay in the read set.
  - The parent's earlier writes survive. The parent catches the error and may go on and commit.
- **Returns validation** runs after the sub-transaction is committed. A `ReturnsValidationError` is catchable, but the nested writes are kept.
- **`useStaleSnapshot`** (mutations only): the nested query runs on a clone of the transaction at its begin timestamp.
  - The clone has no pending writes, so it does not see the parent's.
  - Its reads are discarded: they cause no conflict and count toward nothing.
- **`transactionLimits`:** each given limit becomes `min(usage so far + budget, current ceiling)` for the nested call, and the parent's limits are restored after it.
- **System errors** inside the nested call are not catchable: the whole request fails.

**Execution order and logs**
- Calls are serialized: one nested call at a time, in order.
- The nested call's log lines are added to the parent's as one group when it returns, so they come after the parent's earlier lines and before its later ones.
- The 256-line log limit is shared: "Log overflow (maximum 256). Remaining log lines omitted.".

### 1.3 The 1 s limit (`crates/common/src/knobs.rs`, `crates/isolate/src/timeout.rs`, `termination.rs`)

**The two budgets**
- `DATABASE_UDF_USER_TIMEOUT` (1 s): **user time** is wall time minus the time spent paused in async syscalls (database reads and writes, `runUdf`) and in loading.
- `DATABASE_UDF_SYSTEM_TIMEOUT` (15 s): the total paused time.

**What a user sees**
- When the user deadline passes, the isolate is terminated: even a synchronous `while (true) {}` stops.
- The message is "Function execution timed out (maximum duration: 1s)". It is not catchable, and a mutation does not commit.
- When the system budget runs out: "Your request timed out performing too many system operations."

**Nested calls (the default mode, `SUBFUNCTIONS_IN_SAME_ISOLATE` false)**
- The parent's clock is paused during the call, and the nested function gets its own 1 s / 15 s.
- A nested user timeout comes back to the parent as a catchable error.

**Actions:** these limits do not apply. Actions have their own (V8 actions 1800 s here, Node 600 s).

## 2. What an app can observe

1. `ctx.runQuery` in queries and mutations, and `ctx.runMutation` in mutations, with the semantics above: one transaction, the nested mutation rolled back on error, and catchable errors with Convex's messages.
2. The depth limit, and its message.
3. A query or mutation that computes for more than 1 s of its own time fails with "Function execution timed out (maximum duration: 1s)".

## 3. How bunvex does it

**Today**
- Only actions have `runQuery` / `runMutation`, and each call is its own transaction.
- Queries and mutations have no time limit.

### PR 1 — nested calls

- **Sub-transactions in `Tx`:**
  - `begin()` saves the write map, each index's pending tree (a `sorted-btree` `clone()`, which is copy-on-write and costs O(1)), the created tables, and the write counters.
  - `rollback()` restores them; `commit()` drops the saved copies.
  - Reads are never rolled back.
- **The contexts:** `ctx.runQuery` in queries and mutations, and `ctx.runMutation` in mutations. They resolve the reference or name as actions do.
  - The kind, the arguments and the depth are checked first, with Convex's messages. Internal functions are allowed.
  - The nested handler then runs on the same `Tx`: same identity, same frozen time, read set shared.
  - A nested mutation is in a sub-transaction, rolled back if it throws.
  - The return check comes after; on failure the writes are kept, as in Convex.
  - A nested error reaches the parent as a new `Error` with the nested message, or as a `BunvexError` with its data.
- **Serialization:** nested calls from one function run one at a time, in call order (N4).
- **`useStaleSnapshot`:** a separate read-only `Tx` at the parent's snapshot. Its reads are discarded.
- **`transactionLimits`** for the limits bunvex counts: documents and bytes read, documents and bytes written. The others are accepted and ignored (N3).
- **Log lines:** the nested lines land in the parent's lines as they are printed, which is the same order as Convex's when calls are serialized. The 256-line cap is shared.
- **Depth:** 8 levels, with Convex's message.

### PR 2 — the 1 s limit

- **The clock:** user time is wall time minus the time spent awaiting the store (`outsideExecution` already marks those calls) and nested calls.
- **Checks:** the limit is checked at every database call and at the end of the function.
- **Failure:** "Function execution timed out (maximum duration: 1s)". The error is not catchable: it is re-raised at the end even if the app caught it.
- **System budget:** 15 s of store time, with Convex's message.
- **Knobs:** `DATABASE_UDF_USER_TIMEOUT_SECONDS` and `DATABASE_UDF_SYSTEM_TIMEOUT_SECONDS`, as in Convex.
- **The gap (N5):** a synchronous loop that never reaches a database call cannot be interrupted in one Bun process, unlike V8's `terminate`. It is caught when it ends, or never if it loops forever, and it blocks the server while it runs. That is the same class of gap as DV-02.

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| N1 | The nested call runs in the parent's `Tx` in the same JS context, as Convex's `SUBFUNCTIONS_IN_SAME_ISOLATE` mode, but **with its own 1 s budget, the parent's clock paused** during it, as Convex's default mode | there is one process and no isolates; the budgets follow Convex's default | pending |
| N2 | A nested error reaches the parent with its message and `BunvexError` data, without Convex's appended stack-frame text | the stack is a JS stack here; the message and data are what apps match on | pending |
| N3 | `transactionLimits` applies to documents and bytes read and written. `databaseQueries`, `functionsScheduled`, `scheduledFunctionArgsBytes` and the file limits are accepted and ignored | bunvex does not count those yet | pending |
| N4 | Concurrent nested calls (`Promise.all([ctx.runQuery(a), ctx.runQuery(b)])`) are serialized by a queue on the transaction, as Convex serializes `runUdf` | the same order and results as Convex | pending |
| N5 | The 1 s limit is cooperative: checked at database calls and at the end. A synchronous infinite loop is not interrupted and blocks the process | one Bun process cannot interrupt running JS; a worker per call would cost far more than the limit protects | pending |
| N6 | Store errors (persistence failures, OCC) inside a nested call propagate as they are, rather than being turned into a non-catchable internal error | they already end the transaction on the next store call | pending |

## 5. Tests

**Nested calls**
- Each allowed and refused kind, with Convex's messages.
- A query reading what the calling mutation wrote, and the mutation seeing the nested writes.
- A failed nested mutation: its writes rolled back, the parent's kept, the parent catching and committing.
- `ReturnsValidationError` keeping the writes.
- The depth limit at 9.
- Same identity and time.
- A parent query re-running when a nested query's read changes, as a subscription.
- `useStaleSnapshot` not seeing the pending writes and not conflicting.
- `transactionLimits` lowering the documents read.
- `BunvexError` data through the call.
- Serialized `Promise.all`.
- Log order.

**The time limit**
- A query busy for more than 1 s between two reads fails with the message, and a mutation does not commit.
- Time awaiting the store does not count.
- A nested call has its own budget.
- Catching the timeout does not save the function.
- The knobs.

**Measure:** the cost of the sub-transaction (`begin`, `commit`) on a mutation, and the cost of the clock on a query.
