# STUDY-151 — A batch of small parity items
<!-- index: A batch of small parity items: system table messages, `deploy -y`, the HTTP API's methods, `getServiceToken`/`getServiceUrl`, `setDefaultWebSocketConstructor`, `_audit_log_config` | decided (owner, 2026-10-12); DV-491; implemented (#608, #609, #611, #614, #615, and §6 *n/a*) -->

- **Status:** implemented (owner's decisions, 2026-10-12), one PR per item: §1 system table messages (#608), §2 `deploy -y`
  (#609), §3 the HTTP API's methods (#611), §4 `getServiceToken` /
  `getServiceUrl` (#614), §5 `setDefaultWebSocketConstructor` (#615), §6 `_audit_log_config` *n/a* (this PR)
- **Convex source read:** commit `d8bdde0` of get-convex/convex-backend
  (`npm-packages/convex/src/server/impl/database_impl.ts`, `crates/isolate/src/environment/udf/async_syscall.rs`,
  `npm-packages/convex/src/cli/deploy.ts`, `cli/lib/command.ts`, `crates/local_backend/src/public_api.rs`,
  `npm-packages/convex/src/server/impl/actions_impl.ts`, `crates/application/src/application_function_runner/mod.rs`,
  `npm-packages/convex/src/browser/simple_client.ts`, `crates/model/src/audit_log_config`)
- **Related:** [server-api.md](../parity/server-api.md), [platform.md](../parity/platform.md),
  [client-sync.md](../parity/client-sync.md); STUDY-30, STUDY-35, STUDY-26, STUDY-48, STUDY-67; DV-304

Six rows the parity inventory left partial or missing, each small. Each section covers how Convex does it, what
apps observe, bunvex's version and the decision.

## 1. System tables reached outside `db.system`

**Convex.** The JS layer (`database_impl.ts`) refuses before any syscall: `db.insert("_x", …)` throws "System
tables (prefixed with `_`) are read-only."; `db.query("_x")` throws "System tables can only be accessed from
db.system.query()."; `db.normalizeId("_x", …)` throws "System tables can only be accessed from
db.system.normalizeId()."; the other way, `db.system.query("users")` throws "User tables can only be accessed
from db.query()." and `db.system.normalizeId("users", …)` "User tables can only be accessed from
db.normalizeId().". By id, the backend's `system_table_guard` (`async_syscall.rs`) refuses `get`, `patch`,
`replace` and `delete` on a system table's id with "System tables can only be accessed with db.system." and
`db.system.get` on a user table's id with "User tables cannot be accessed with db.system.". Plain errors with
those messages (the backend's carries the code `SystemTableError`, not shown to the function).

**bunvex before.** One message for every operation, bunvex's own ("System table _x is not accessible here."),
the same for `db.system.query("users")`; `db.normalizeId("_x", …)` returned null. The id forms already had
Convex's messages.

**bunvex now.** Convex's message per operation (`findTable` in `packages/core/src/tx.ts`, `system-reader.ts`),
`insert` refusing before it reads the value, as Convex's; `db.normalizeId("_x", …)` throws (owner,
2026-10-12: as Convex). Kept: `db.system` reads only the system tables apps may see (the virtual ones), any
other `_` name answering as an empty table, as before (STUDY-107).

## 2. `deploy -y`

**Convex.** `-y, --yes` (hidden; `cli/lib/command.ts`) skips one prompt, `askToConfirmPush` in `cli/deploy.ts`,
asked when the deployment selected is not the dev deployment named in `CONVEX_DEPLOYMENT`: a cloud selection.
A self-hosted target has no deployment name, so the prompt never shows; the other deploy prompts (large index
changes) answer to their own flags.

**bunvex before.** `bunvex deploy -y` failed with an unknown option. **Now:** `-y` and `--yes` are accepted,
hidden, doing nothing, so a script written for Convex runs. Previews (`--preview-*`) need Convex's preview deploy keys: cloud
only, *n/a*.

## 3. The HTTP API's methods

**Convex** (`public_api.rs`) serves `GET` and `POST /api/query`, and `POST` only for `/api/query_ts`,
`/api/query_at_ts`, `/api/query_batch`, `/api/mutation`, `/api/action`, `/api/function` and `/api/run/{fn}`: no
GET form of the others. bunvex serves every one of them. A wrong method gets axum's 405 with the methods the route
takes, and HEAD is served by a GET handler; checked against Convex's local backend: `allow: POST` on
`/api/query_ts`, `allow: GET,HEAD,POST` on `/api/query`, `HEAD /api/query` answered as GET.

**bunvex before.** A wrong method on `/api/query_ts` answered 404, and `/api/query`'s 405 said `allow: POST`;
`HEAD /api/query` answered 405. **Now:** as Convex's. The rows are done (they listed GET forms Convex does not
have).

## 4. `getServiceToken` / `getServiceUrl`

**Convex.** Exports of `convex/server` (`actions_impl.ts`), for actions only (syscalls `1.0/createServiceToken`,
`1.0/getServiceUrl`, handled in the action environment): a token and the URL of Convex's AI gateway, a Convex
Cloud service. On a self-hosted deployment `getServiceToken("ai-gateway")` fails, `AiGatewayUnavailable`
(`application_function_runner/mod.rs`); `getServiceUrl` still returns the cloud gateway's URL.

**bunvex before.** Not exported: an import failed. **Now** (owner, 2026-10-12): both exported from
`bunvex/server` and its isomorphic entry (`service-tokens.ts`). In an action (or an HTTP action) both fail with
`AiGatewayUnavailable` and Convex's self-hosted message in bunvex's words ("… the AI gateway is a hosted cloud
service. Call your model provider directly with your own API key."); elsewhere, Convex's "Unknown async operation
1.0/createServiceToken"; no argument, Convex's `validateArg` message; another service, serde's "unknown variant". `getServiceUrl` failing where Convex returns a URL is DV-491 (the
cloud URL cannot be in bunvex's code, and is of no use without a token).

## 5. `setDefaultWebSocketConstructor`

**Convex** (`browser/simple_client.ts`): an internal export setting a module default the `ConvexClient`
constructor uses when the options have no `webSocketConstructor` and there is no global `WebSocket`; Convex's
Node entry calls it with the `ws` package.

**bunvex before.** No such function. **Now** (owner, 2026-10-12): `setDefaultWebSocketConstructor`, internal,
exported from `@bunvex/client`, with Convex's three conditions in `BunvexClient`'s constructor; no `ws`
dependency and no Node entry (Bun and Node 22+ have a global `WebSocket`; older Node passes the constructor or
sets the default).

## 6. `_audit_log_config`

**Convex** (`crates/model/src/audit_log_config`): one row, `{firehoseStreamName}`, the AWS Firehose stream custom
audit logs go to instead of log streams. No open-source code writes it (cloud tooling does); the Firehose path
needs AWS credentials. Whether `custom_audit` reaches log streams is a cloud plan entitlement, off on self-hosted.

**bunvex** has the open-source behaviour: `log.audit` and its limits, `custom_audit` refused to log sinks as on
self-hosted Convex (DV-304), the table present and empty. Decided (owner, 2026-10-12): the row is *n/a*
(cloud only); `custom_audit` stays refused.

## Divergences

| # | Divergence | Decision |
|---|---|---|
| DV-491 | `getServiceUrl` fails on a self-hosted deployment, where Convex returns its cloud AI gateway's URL | owner, 2026-10-12 (§4) |

## Tests

- §1: `tx-b-edges` (each operation's message, `db.system.normalizeId` of a user table), with the earlier
  expectations updated (`writes`, `implicit-tables`, `count`, `instance-secret`, `system-reader-edges`,
  `id-forms`, `sync`).
- §2: `deploy` (a deploy with `-y` and with `--yes` succeeds).
- §5: `default-websocket` (the default without a global one; the options' and a global one win).
- §4: `service-tokens` (both in an action, the argument checks, outside an action).
- §3: `http-request-errors` (`/api/query_ts` among the POST routes' 405s; `/api/query`'s 405 and its HEAD).
