# STUDY-82 — The `log` export: `log.audit` and `log.vars`

- **Status:** implemented
- **Convex source read:** `main` of get-convex/convex-backend (4577b9031), 2026-10-04
- **Related:** [STUDY-59](STUDY-59-log-streams.md) and [STUDY-70](STUDY-70-provider-sinks.md) (log streams,
  the `custom_audit` topic, DV-304), [STUDY-48](STUDY-48-audit-log.md) (the deployment audit log, a different
  thing)

## 1. How Convex does it

**The function API** (`npm-packages/convex/src/server/log.ts`, `audit_logging.ts`, `logVars.ts`; commits
bc3113be1, b1e773165, ee89a2cf3):

- `log` is exported from `convex/server` as `{ audit, vars }`.
- `vars` holds five symbols: `requestId`, `ip`, `userAgent`, `now` (ms) and `convexActor`.
- `audit(body)` deep-copies the body:
  - each var symbol becomes `{ $var: name }`;
  - an unknown symbol throws `Unknown audit var symbol: <symbol>.`;
  - a key starting with `$` throws ``Audit log body keys must not start with "$": "<key>"``.
- It then calls the `1.0/auditLog` syscall with `{ body, version }`.

**The syscall** (`crates/isolate/src/environment/udf/async_syscall.rs:1209-1222`, `udf/mod.rs:1300-1311`):

- In a query or mutation, it adds the line to the function's lines. If they would exceed
  `AUDIT_LOG_MAX_HEAP_SIZE_BYTES` (4 MB), it fails with a bad request, `AuditLogsExceedLimits` "Audit logs
  exceed function execution limits", a JS error the function sees.
- A nested `runQuery` / `runMutation`'s lines join the caller's, whatever the nested result
  (`async_syscall.rs:570-615`).
- In an action it is a bad request, `AuditLogNotSupportedInAction`: "Audit logging is not yet supported in
  actions" (`action/async_syscall.rs:96-101`).

**Resolution** (`crates/common/src/audit_log_lines.rs`):

- When a top-level query or mutation ends (`application_function_runner/mod.rs:846-857`, `:1245-1251`;
  whatever its result, before the mutation commits), its lines are resolved with `AuditLogVars`:
  - the request id, IP, User-Agent and now;
  - the admin actor, `convex_actor_var` (`crates/keybroker/src/broker.rs:363-388`): a member's or an access
    token's identity, otherwise `None`.
- `resolve_bodies` checks three limits, each a bad request:
  - more than `AUDIT_LOG_MAX_LINES` (500): `TooManyAuditLogLines`, "Function execution exceeded the maximum
    of 500 audit log lines.";
  - a line whose maximum size (its JSON, plus 1026 bytes for each variable) is over
    `AUDIT_LOG_MAX_LINE_SIZE_BYTES` (100 000): `AuditLogLineTooLarge`;
  - lines whose summed maximum is over `AUDIT_LOG_MAX_TOTAL_SIZE_BYTES` (4 000 000): `AuditLogLinesTooLarge`.
- The lines are then sent to the log streams as `CustomAudit { body }` events (`application/src/audit_logging.rs`),
  or to AWS Firehose when the deployment has one.
- A cached query's hit replays its lines with fresh variables (`cache/mod.rs:517`).

**Delivery** (`crates/log_streaming/src/sinks/utils.rs:65-71`, `lib.rs:563-567`;
`crates/model/src/backend_info/mod.rs:118-136`):

- A sink subscribed to every topic leaves `custom_audit` out.
- Naming it explicitly needs the `custom_audit_logs_in_log_streams_config_enabled` entitlement, which is
  false without backend info, so on a self-hosted deployment.
- So on a self-hosted Convex, `log.audit` runs its checks and its lines go nowhere.

## 2. What an app can observe

1. `import { log } from "convex/server"` exists. Without it, an app importing it fails at import.
2. `log.audit` checks the body (`$` keys, unknown symbols) and refuses to run in an action.
3. Too much held at once gives a catchable error.
4. Resolution limits fail the request with 400 and the code.
5. On a self-hosted deployment, no sink receives the lines.

## 3. How bunvex does it

`packages/server/src/log-audit.ts`, exported from `@bunvex/server` (so `bunvex/server`):

- **`log.audit` and `log.vars`**: Convex's body checks and messages.
  - The lines go into an `AsyncLocalStorage` scope that the function runner opens around each top-level query
    and each mutation attempt (`Functions.withAudit`). Nested calls run in the caller's async context, so their
    lines join the caller's.
  - Outside such a scope, in an action or an HTTP action, `log.audit` throws Convex's action message.
  - The 4 MB held-size check counts each line's JSON length.
- **Resolution.** When the run ends, whether or not it succeeded, the lines are resolved with the request's id,
  IP and User-Agent, `now` and the actor.
  - Each limit failure is an `AuditLogLimitError` with Convex's code and message. The HTTP API answers it with
    400 `{code, message}`.
  - The lines are sent to the log manager as `custom_audit` events, serialized as Convex's V2:
    `{timestamp, topic: "custom_audit", body}`.
- **The actor variable** is `log.vars.bunvexActor`, since public names carry no "convex" (DV-03). It is always
  null: a self-hosted admin key belongs to no member or access token, which is what Convex's
  `convex_actor_var` returns `None` for.
- **The sink filter** (`passes`) now leaves `custom_audit` out of subscribe-all sinks, as Convex's. Naming
  the topic is refused, as it already was (DV-304).

**Measured.** Every top-level run now opens one `AsyncLocalStorage` scope. On 20 000 in-memory mutations,
sequential and concurrent, median of 5, the cost is within noise: main 30.8–31.0 / 19.1–21.1 µs, this
branch 30.4–30.8 / 19.0–19.7 µs.

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| L1 | `log.vars.bunvexActor` for `convexActor` | rule 5 | DV-03 (an instance of it) |
| L2 | A cached query's hit does not replay its lines with fresh variables | No sink can take `custom_audit` on a self-hosted deployment, so it cannot be observed; to build when one can | gap (unobservable) |
| L3 | A sync query whose lines exceed the resolution limits fails as a query (`QueryFailed`) rather than the way Convex's worker handles a post-run bad request | an edge of an edge; the HTTP API answers as Convex's | gap |

## 5. Tests

`packages/server/test/log-audit.test.ts`, over the HTTP API with a capturing log manager:

- a query's line with every variable resolved (the forwarded IP, the User-Agent, a 16-hex request id, now,
  and a null actor);
- a mutation's line and its nested query's, in order;
- a run that fails still sends its lines;
- Convex's messages for `$` keys, an unknown symbol, and an action;
- the four limits: lines, a line's maximum size counting variables at 1026 bytes, the total, and the held
  size;
- subscribe-all sinks leave `custom_audit` out, and a sink that names it gets it.

Sabotage checks, each failing a test:

- no `$` check;
- actions allowed;
- variables unresolved;
- variables not counted at their maximum;
- subscribe-all receiving `custom_audit`;
- no 400;
- a failed run's lines dropped.
