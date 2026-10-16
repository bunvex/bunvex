# STUDY-155 — Components: calls across components (STUDY-152 step 5)

- **Status:** decided (owner, 2026-10-16): Q-1 a 400 for a branch reference (DV-531), Q-2 (C4), Q-3 and Q-5 as
  Convex, Q-4 refused until step 7 (§5).
- **Convex source read:** `d8bdde0`, the reference commit (docs/parity/upstream.md). Paths are relative to its root.
  Abbreviations:
  - `u/async_syscall.rs` = `crates/isolate/src/environment/udf/async_syscall.rs`
  - `a/async_syscall.rs` = `crates/isolate/src/environment/action/async_syscall.rs`
- **bunvex source:** `main` after STUDY-154. Paths are relative to `packages/`.
- **Scope.** A function of the app or of a component calling a function of another component:
  - the references (`components.counter.lib.add`) and names;
  - the nested transaction;
  - identity, arguments and errors across the boundary;
  - function handles.

  Scheduling into a component is step 7 with the rest of the scheduler (§3.4).
- **Related:** [STUDY-152](STUDY-152-components-restudy.md) (C4), [STUDY-154](STUDY-154-component-runtime.md).

## 1. How Convex does it

### 1.1 What a call sends, and how it resolves

- **The client** (`npm-packages/convex/src/server/components/paths.ts:20-48`):
  - `getFunctionAddress` sends `{functionHandle}` for a `function://` string, `{name}` for any other string or an
    `api.*` reference, else `{reference}`.
  - `components.counter.lib.add` is `_reference/childComponent/counter/lib/add` (`components/index.ts:790-815`).
- **The syscalls:**
  - a query's or mutation's `ctx.runQuery` / `runMutation` is `1.0/runUdf` (`impl/registration_impl.ts:755-772`);
  - an action's are `1.0/actions/query|mutation|action` (`impl/actions_impl.ts:12-56`);
  - `createFunctionHandle` is `1.0/createFunctionHandle`.
- **Resolution in a query or mutation** (`u/async_syscall.rs:709-718`; `model/src/components/mod.rs:64-170`):
  - `{name}` resolves **in the caller's own component**, any visibility.
  - `childComponent/<name>/<attrs>` resolves **among the caller's direct children only**, to a **public** function
    (`resolve_export`, `mod.rs:191-221`). The attributes are the module path and the function
    (`file_based_routing.rs:79-95`). A grandchild (`components.a.b.lib.f`) reads as module `b/lib` of `a`: "does
    not export". A child cannot name its parent; only a handle passed down reaches it.
  - The errors are 400 `InvalidReference`, caught in JS as a plain `Error` with the message:

    | Case | Message |
    |---|---|
    | Unknown child | "Child component 'x' not found" |
    | Missing or internal export | "Child component 'counter' does not export 'lib.add'" |
    | Wrong kind | "Trying to execute lib.js:add in 'counter' as Query, but it is defined as Mutation." (`InvalidArgs`) |

  - **A branch, not a function** (`components.counter`, `components.counter.lib`) fails with a system error (500)
    (`Expected at least one path component`, `MissingFilename`).
- **Resolution in an action** (`isolate/src/environment/action/task_executor.rs:225-260`):
  - It uses a preloaded map of its own component's functions and its children's public exports.
  - A miss, a branch included, is 400 `InvalidReference`, "Couldn't resolve counter.lib.missing".

### 1.2 The nested transaction

- **The same transaction.** A nested query or mutation runs in the caller's transaction, in a subtransaction
  (`u/async_syscall.rs:504-698`; `database/src/transaction.rs:417-455`):
  - It sees the caller's snapshot and pending writes, and shares its limits and usage.
  - A failed nested mutation's writes are rolled back. The caller may catch and go on.
  - The callee's **reads stay** in the caller's read set (they are not in the subtransaction token), so a query
    calling a component's query re-runs when the component's data changes.
- **Depth limit.** The depth is 8, with 400 `MaximumCallDepthExceeded`, "Cross component call depth limit exceeded.
  Do you have an infinite loop in your app?". Every nested call counts, within one component too.
- **`transactionLimits` and `useStaleSnapshot`** work as for the app's nested calls (bunvex has both, STUDY-41).
- **From an action**, a call is its own transaction, as the app's `runQuery` from an action
  (`application_function_runner/mod.rs:2132-2184`).

### 1.3 Identity, arguments, errors

- **Identity:**
  - From a query or mutation, the component sees the caller's user (`u/async_syscall.rs:973-1003`).
  - From an **action**, `propagate_component_auth` (`model/src/components/auth.rs:1-19`) passes an admin's
    identity, and a user's only from the app to the app; a component called from an action sees `null`.
  - A scheduled job has none.
- **Arguments and return values:**
  - They are checked by the callee's validators against the callee's tables (`validation.rs:677-718`;
    `u/async_syscall.rs:686-695`).
  - The texts are `ArgumentValidationError: …` and `ReturnsValidationError: …`.
- **`v.id` across namespaces (C4).**
  - An id is checked by its table **number** in the callee's namespace, then that table's name
    (`common/src/schemas/validator.rs:118-144`).
  - So the app's id is accepted by a component's `v.id("x")` when the component's table of that number is named
    `x`.
  - This is what C4 asked; the source confirms "accepts".
- **Errors in the callee:**
  - The caller gets `Error("Uncaught Error: boom\n    at …")` with the callee's frames and no other prefix
    (`common/src/errors.rs:579-584, 813-830`).
  - A `ConvexError` keeps its class and `data` (`impl/syscall.ts:45-51`).

### 1.4 Function handles

- **Rows.** `_function_handles` is global: `{component, path, deletedTs?}`, a row per function of every component,
  any visibility, written at push. An unmounted component's rows are soft-deleted (`model/src/components/handles.rs`;
  `config.rs:593-594, 694-716`).
- **Creating one.** `createFunctionHandle(components.counter.lib.add)` gives the counter's row.
- **Calling one** reaches any visibility. A deleted row is `FunctionHandleNotFound`, "Function handle not found".
  This is how a child calls back into its parent: the parent passes a handle down.

### 1.5 Logs

- **A nested query or mutation** is no execution of its own. Its console lines come back inside the caller's, each
  attributed to the callee's component and function (`LogLine::SubFunction`, `isolate/src/environment/udf/mod.rs:1347-1377`;
  `application/src/function_log.rs:209-262`).
- **A call from an action** is its own execution, with `parentExecutionId`.

## 2. bunvex today

- **Client.** `getFunctionAddress` (`protocol/src/api.ts:112-119`) already gives `{reference}` for
  `components.*`.
- **Server.** The server cannot resolve one: `functionNameOf` (`server/src/function-handles.ts:115`) uses
  `getFunctionName`, which throws "Expected function reference in the current component like …".
- **Names.** Since STUDY-154 PR 2, a component's function calls its own functions by name (`runNested`,
  `actionCtx`). Nothing crosses a component.
- **Nested calls.** A nested mutation already runs in a subtransaction (`db.begin()` / `rollback`, `runNested`),
  with Convex's depth limit and text (`MAX_NESTED_CALL_DEPTH`).
- **Handles.** `syncFunctionHandles` writes the app's handles only.

## 3. How bunvex would do it

### 3.1 Resolving a call

One resolver, `resolveCall(ref, caller, db)` in `server/src/function-handles.ts`, gives the registry name of the
target (STUDY-154's `componentFunctionName` for a component's function), as Convex's `resolve`:

- **`{name}`** resolves in the caller's component, any visibility (as today).
- **`{reference}`** `_reference/childComponent/<child>/<module path…>/<fn>` resolves among the caller's direct
  children:
  - the child's row comes from `_components` by `(parent, name)`, read in the transaction;
  - the export comes from the child's installed functions, public only;
  - Convex's texts: "Child component 'x' not found", "Child component 'counter' does not export 'lib.add'". From an
    action, "Couldn't resolve counter.lib.add" (Q-1).
- **`{functionHandle}`** is looked up in `_function_handles`, any component.
- **Other reference forms** (`currentSystemUdfInComponent`, `componentArgument`) give Convex's texts. They are not
  built further: system functions in components are step 9's, and component arguments are legacy (STUDY-153 C-13).

### 3.2 Running it

- **The callee's namespace.** `invoke` already runs a component's function in its namespace (STUDY-154 PR 2). It must
  also switch **back to the app's** when a component calls an app function through a handle:
  `db.inComponent(null, …)`.
- **The transaction.** The nested transaction is the existing one: a failed nested mutation's writes are rolled back,
  its reads kept. The depth limit counts every call, as today.
- **From an action**, a call into a component is its own transaction, as today's `runQuery` from an action.
- **Identity:**
  - A query's or mutation's callee sees the caller's identity (the same `Tx`).
  - An action's call into a component carries Convex's `propagate_component_auth`: an admin passes; a user only
    from the app to the app; otherwise none (Q-3).
- **Arguments and returns** are checked by the callee's validators, `v.id` against the callee's namespace (C4: as
  Convex, accepted when the number and name match).
- **Errors.** The callee's errors cross as today's nested errors: `Uncaught …` with its frames, `BunvexError` keeping
  its data.

### 3.3 Handles

- **At push.** `syncFunctionHandles` writes each mounted component's functions with its `component` field, in the
  push's commit, and soft-deletes an unmounted one's (as Convex's `apply_config_diff`).
- **Creating.** `createFunctionHandle(components.counter.lib.add)` resolves the export, then the row.
- **Calling.** A call through a handle reaches any visibility.

### 3.4 Not in step 5

- **Scheduling a component's function** (`scheduler.runAfter(0, components.counter.lib.add, …)`): Convex stores the
  job in the caller's namespace with the target's component path, and the scheduler runs it in that component.
  bunvex's scheduler is the app's. Proposed: refuse it until step 7, with an error naming what is missing (Q-4).
- **The dashboard's display** of a nested call's lines with the callee's component: step 9. The log lines' source
  carries the callee's `componentPath` in step 5 (Q-5).

## 4. Proposed PRs

1. **server: calls into a child component.**
   - `resolveCall`: references among the direct children, public exports, Convex's texts per context.
   - Nested calls from queries and mutations (subtransaction, namespace switch, identity), and from actions
     (`propagate_component_auth`).
   - Argument and return checks in the callee's namespace; errors across.
   - Tests: each of §1.1's cases from a query, a mutation and an action; a failed nested mutation rolled back and
     caught; a query re-run when the component's data changes; the depth limit across components; identity from a
     mutation and from an action; `v.id` of the app's table into a component (C4); a `BunvexError` across.
2. **server: handles across components.**
   - Rows at push per component, soft-deleted on unmount.
   - `createFunctionHandle(components.…)`.
   - A handle passed to a child and called back into the parent (the namespace switch); a deleted one's
     `FunctionHandleNotFound`.

### As built, PR 1 (`server/src/functions.ts`, `logs.ts`, `log-events.ts`, `scheduler.ts`)

- **Resolving.** `resolveCall(ref, callerComponent, db, action)` is Convex's `resolve`.
  - A name resolves among the caller's own component's functions.
  - A `_reference/childComponent/<child>/<attributes>` resolves among the caller's direct children only
    (`componentInParent`, `rootComponent`), and only to a public export.
  - A handle passes through.
  - The texts are Convex's: "Child component 'nope' not found", "Child component 'counter' does not export
    'lib.secret'", and from an action "Couldn't resolve counter.lib.add".
  - A branch (`components.counter.lib`, or `components.counter`) is "does not export 'lib'" (or `''`). From a
    query or mutation too it is a refusal like the others (`InvalidReference`, a plain `Error` in the caller), not
    a system error (DV-531).
  - The wrong kind is Convex's text with the component's path: "Trying to execute lib.js:add in 'counter' as Query,
    but it is defined as Mutation.".
- **Running.**
  - A nested `ctx.runQuery` / `runMutation` runs the callee in its namespace (`inComponentRun`), and goes back to
    the app's with `inAppRun` when a component calls an app function through a handle.
  - Its arguments and return value are checked in the callee's namespace: an app `v.id` passes where the
    component's table of that number has that name (C4, Q-2).
  - A failed nested mutation's writes are rolled back, and the caller may catch the error. A `BunvexError` crosses
    with its data. The depth limit counts calls inside a component.
  - An action resolves the target before it builds the caller (`callerOf`), so a miss is not wrapped as
    "Uncaught Error". Its identity is the caller's unless the call crosses into or out of a component, which gets
    none (`propagate_component_auth`, Q-3).
- **Scheduling (Q-4).** A reference to a component's function is "Scheduling a function of a component is not
  supported yet", until step 7.
- **Logs (Q-5).** `withSubFunction` tags the callee's console lines with `{componentPath, path}`, and the log stream
  carries them as each line's source (`component_path`).
- **Measured.** 200 nested `runQuery` calls from one query: about 0.42 ms before, about 0.53 ms after (+0.5 µs a
  call, the resolution and the sub-function scope).
- **Tests.** `server/test/component-calls.test.ts` covers each of §1.1's cases from a query, a mutation and an
  action, plus the rollback, a re-run subscription, identity, C4, `BunvexError`, the depth limit, the log source
  and the scheduler's refusal. Sabotage: 9 of 9 checks failed when the fix was broken.

### As built, PR 2 (`server/src/function-handles.ts`, `functions.ts`, `server.ts`, `scheduler.ts`)

- **Rows.**
  - `_function_handles` rows carry their component.
  - `installComponents` runs `syncFunctionHandles(db, paths, component)` for each mounted instance.
  - An unmount soft-deletes that instance's rows. Its handles are then "Function handle not found", as a deleted
    function's.
- **Names.** `componentFunctionName` / `splitComponentFunctionName` moved into `function-handles.ts`, which
  `functions.ts` re-exports.
- **Resolving.**
  - `resolveHandle` reads the rows in the app's namespace, wherever the call runs, and gives a component row's
    registry name.
  - A handle to an app function, called from a component, runs in the app's namespace.
- **Creating.** The handle scope's `resolve` lets `createFunctionHandle(components.counter.lib.add)` find the
  child's row. A component may hand out a handle to its own internal function, and the app may call it.
- **Scheduling (Q-4).** A handle to a component's function is refused with PR 1's text until step 7.
- **Tests.** Five more cases in `component-calls.test.ts`: the app's handle, a call back into the app, an internal
  function, an unmounted component's handle, and scheduling. Sabotage: 7 of 7 checks failed when the fix was
  broken.

## 5. Questions for the owner

| # | Where bunvex would differ | Convex | Recommendation | Decision |
|---|---|---|---|---|
| Q-1 | **A reference to a branch, not a function** (`components.counter`, `components.counter.lib`) from a query or mutation | a 500 (system error); from an action, 400 "Couldn't resolve …" | A 400 `InvalidReference` in both, "Child component 'counter' does not export 'lib'" (the attributes joined, empty for none): only a code mistake reaches it, and bunvex's 500s page as internal errors. The other texts stay Convex's per context (a query's "does not export", an action's "Couldn't resolve") | **Decided (owner, 2026-10-16): 400 in both** (DV-531) |
| Q-2 | **`v.id` across namespaces (C4)** | accepts the app's id when the component's table of that number has that name | As Convex (no DV): C4 is answered by the source, and an app relies on it no more than on table numbers | **Decided: as Convex** (no DV) |
| Q-3 | **Identity into a component from an action** | `null` (a user passes from a query or mutation, not from an action) | As Convex (no DV): a component written for Convex expects it; the inconsistency is Convex's, documented | **Decided: as Convex** (no DV) |
| Q-4 | **Scheduling a component's function** before step 7 | supported | Refuse it until step 7, with an error naming what is missing (an interim gap, as STUDY-154's P-2) | **Decided: refused until step 7** |
| Q-5 | **A nested call's log lines** | attributed to the callee's component and function (`SubFunction`) | As Convex: each line's source names the callee in the log stream; the dashboard's display is step 9 | **Decided: as Convex** |

## Divergences

| # | Divergence | Decision |
|---|---|---|
| DV-531 | A reference to a branch, not a function (`components.counter`, `components.counter.lib`), is a 400 `InvalidReference` from a query or mutation too, not Convex's 500 (Q-1) | owner, 2026-10-16 |
