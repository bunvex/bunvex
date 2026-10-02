# STUDY-44 — `ctx.meta`: function, transaction, deployment and request metadata

- **Status:** built (no divergence; nothing for the owner to decide)
- **Convex source read:** commit `4577b9031` of get-convex/convex-backend
- **Related:** [STUDY-41](STUDY-41-nested-calls-and-execution-limit.md) (the transaction limits the metrics
  report), [STUDY-27](STUDY-27-auth.md) (the token), [STUDY-30](STUDY-30-scheduler-and-crons.md) (scheduled
  functions).

## 1. How Convex does it

`ctx.meta` (`npm-packages/convex/src/server/meta.ts`, `impl/meta_impl.ts`; the backend's
`crates/isolate/src/environment/udf/async_syscall.rs` `tx_metrics`, `function_metadata`,
`deployment_metadata`, `request_metadata`, `udf/syscall.rs` `syscall_snapshot_ts`, and
`environment/action/async_syscall.rs`):

| Method | In | Returns |
|---|---|---|
| `getFunctionMetadata()` | query, mutation, action | `{ name, componentPath, type, visibility }`: `name` is the stripped path (`"dir/module:fn"`, no `.js`; a default export is `"dir/module"`), `componentPath` `""` for the app, `type` and `visibility` (`"public"`/`"internal"`) from the registration |
| `getTransactionMetrics()` | query, mutation | per limit `{ used, remaining }` (`remaining` = the current limit − used, so a nested call's lowered limit shows): `bytesRead`, `bytesWritten`, `databaseQueries`, `documentsRead`, `documentsWritten`, `functionsScheduled`, `scheduledFunctionArgsBytes`, and the internal file ones |
| `getDeploymentMetadata()` | all | `{ name, region, class }`: self-hosted and local Convex return the instance name, `region: null`, `class: "s16"` |
| `getSnapshotTs()` | query, mutation | the transaction's begin timestamp in nanoseconds (a bigint), synchronously; it **observes time** (a query that reads it is cached as one that read `Date.now()`) |
| `getRequestMetadata()` | mutation, action | `{ ip, userAgent, requestId, scheduledFunctionId, authToken }`: `ip` from the first `x-forwarded-for` entry, else the connection's address; `userAgent` from the header; the request id; the id of the scheduled function this execution belongs to (propagated to the functions it calls), else null; the user's raw JWT, null for an admin key or no token. In a query the backend refuses it ("Cannot get request metadata in a query"); the query's `meta` does not even have the method |

Nested calls share the caller's request metadata and snapshot; a scheduled function and what it calls
report its id.

## 2. What an app can observe

Each method's presence per function type, its values and their formats, that `getSnapshotTs` makes a query
time-dependent, and that the metrics follow the (nested) limits.

## 3. How bunvex does it

- `meta` on every context (`functions.ts`), built from the function's name and definition, the `Tx`
  (usage and limits from STUDY-41 N3, `snapshot` × 1000 for nanoseconds, `observeTime()`), the engine's
  instance name, and a new `Caller.request` (`{ ip, userAgent, requestId, authToken, scheduledFunctionId }`)
  that the HTTP routes, the sync protocol, HTTP actions and the scheduler fill in, and `Tx.request` carries
  to mutations.
- `ip`: `x-forwarded-for`'s first entry, else Bun's `server.requestIP()` (of the API or the site server).
- An HTTP action's `meta` names it `http` (public action), as Convex runs it as `http.js:default`.

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| M1 | The internal file metrics (`filesRead`, …) report `used: 0` and the full limit | as Convex: it never counts them either | same as Convex (no divergence) |

## 5. Tests

Every method in each function type (and absent where Convex has none); the metrics under a nested call's
limits; `getSnapshotTs` making a query time-dependent; request metadata over HTTP (ip from
`x-forwarded-for`, user agent, request id, the token for a user, null for an admin key), over the sync
protocol, from a scheduled function and what it calls.
