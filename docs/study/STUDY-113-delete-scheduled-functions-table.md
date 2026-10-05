# STUDY-113 — `POST /api/delete_scheduled_functions_table` and the audit events left

- **Status:** implemented, no divergence
- **Convex source read:** `main` of get-convex/convex-backend (4577b9031), 2026-10-05
- **Related:** STUDY-30 (scheduled functions), STUDY-34 (admin API), STUDY-42 (hidden and deleted tables),
  STUDY-48 (audit log)

## 1. How Convex does it

**The route.** `crates/local_backend/src/scheduling.rs:181-206` `delete_scheduled_functions_table`, mounted in
the dashboard router with its OpenAPI entry (`dashboard.rs:356`). Body `{componentId?: string}` (camelCase,
`Json` extractor), parsed with `ComponentId::deserialize_from_string`; answer `200` with an empty body. The
dashboard's Schedules page calls it from "Delete all".

**The work.** `crates/application/src/lib.rs:3266-3292` `delete_scheduled_jobs_table`:

1. `identity.require_operation(DeploymentOp::WriteData)` (`crates/roles/src/eval.rs:283-302`): a system
   identity passes, an admin (or acting user) needs the operation (else 403 `OperationNotPermitted`), any other
   identity is `BadAdminKey`.
2. One transaction: `TableModel::replace_with_empty_table` for `_scheduled_jobs`, then for
   `_scheduled_job_args` (the arguments live apart in Convex). Each table gets a new, empty tablet with the same
   name, number and indexes; the old tablet is deleted. Whatever the table holds (pending, in progress, done,
   canceled), it is gone at once: the cost does not depend on the number of jobs.
3. Commit with the audit event `DeleteScheduledJobsTable { component_id, component }`, action
   `delete_scheduled_jobs_table` (`crates/model/src/deployment_audit_log/types.rs:204-207, 491-499`): for the
   root, `component_id` is `null` and `component` is `null`. There is no check that the table had anything: an
   empty table is replaced too, and the event is written.

**The executor afterwards.** `crates/application/src/scheduled_jobs/mod.rs`: every step of a job re-reads its
document in a new transaction (`new_transaction_for_job_state`, lines 1066-1093). When the document is missing
and its tablet no longer exists ("The scheduled jobs table could have been deleted since we queried this
scheduled job"), it answers `None`, and every caller (`run_function`, `handle_mutation`, `handle_action`,
`complete_action`, `schedule_retry`) returns without doing anything. So an action running at that moment runs to
its end and records nothing; a mutation job's next attempt does not run. The loop queries the index of the new
table and finds nothing due. A function scheduled by an action whose job is gone is scheduled normally (the
parent's state is `None`, not `Canceled`: `crates/model/src/scheduled_jobs/mod.rs:276-318`).

**The audit events Convex declares but bunvex does not record** (`DeploymentAuditLogEvent`, checked by grepping
`crates/` and `npm-packages/system-udfs` for each variant's constructor and its callers):

| Event | Where Convex emits it | For bunvex |
|---|---|---|
| `build_indexes` | nowhere: never constructed outside `types.rs` | not emitted by Convex's open-source backend |
| `change_deployment_state` | nowhere: never constructed | not emitted by Convex's open-source backend |
| `change_system_stop_state` | `Application::set_system_stop_state` (`application/src/deployment_state.rs:46-68`), which nothing calls | not emitted by Convex's open-source backend |
| `replace_environment_variable` | `EnvironmentVariablesModel::edit` (`model/src/environment_variables/mod.rs:194-262`), which nothing calls | not emitted by Convex's open-source backend |
| `push_config` | the legacy `/api/push_config` (`application/src/lib.rs:2279`) | not applicable: bunvex has only deploy2 (`push_config_with_components`, done) |
| `delete_component` | `/api/delete_component` (`local_backend/src/dashboard.rs:178`) | not applicable: no components (DV-55) |
| `clear_tables` | streaming import's `PUT /api/streaming_import/clear_tables` (`application/src/snapshot_import/mod.rs:745`) | pending: comes with streaming import (missing) |
| `add_documents`, `update_documents`, `delete_documents`, `create_table` | the dashboard's `_system/frontend` mutations (`addDocument.ts`, `patchDocumentsFields.ts`, `replaceDocument.ts`, `deleteDocuments.ts`, `createTable.ts`) via `writeAuditLog` | pending: come with the dashboard's data source |

## 2. What an app can observe

- `POST /api/delete_scheduled_functions_table` with an admin key that has WriteData: 200, empty body.
- Afterwards `db.system.query("_scheduled_functions")` returns nothing, done jobs included; no job that was
  pending runs; `ctx.scheduler.cancel` / `db.system.get` of an old id finds nothing.
- An action running at that moment finishes; nothing about it is recorded. A mutation job running at that moment
  does not commit its writes.
- New jobs scheduled afterwards run normally.
- A read-only key: 403 `OperationNotPermitted`; no key: refused.
- One `delete_scheduled_jobs_table` audit-log entry, `{component_id: null, component: null}`.

## 3. How bunvex does it

- **Engine** (`packages/core/src/engine.ts`): `replaceWithEmptyTables(names, body)`, bunvex's
  `replace_with_empty_table`, built from STUDY-42's hidden tables: for each name a hidden table with the same
  number and the active table's indexes (`createHiddenTable`), then `activateTables` makes them active and marks
  the old ones deleting in **one commit**, running `body` (the audit event) in it. The old documents are removed
  in the background, as any deleted table's. It costs the same for 10 jobs or a million. (The hidden table is
  created in a commit of its own first; it is invisible, and if the activation fails it is dropped at once.)
  bunvex keeps a job's arguments in its `_scheduled_functions` document (STUDY-30 S2), so there is one table to
  replace, not two.
- **Route** (`packages/server/src/server.ts`): next to `/api/cancel_all_jobs` and `/api/delete_tables`, after
  the same `WriteData` check; a non-empty `componentId` is `ComponentsNotSupported`, as the neighbours.
- **Audit event** (`audit-log.ts`): `deleteScheduledJobsTable()`, `delete_scheduled_jobs_table` with
  `{component_id: null, component: null}`.
- **Executor** (`scheduler.ts`): it was woken by commits that write the `by_next_ts` index, whose id it read at
  start. A replaced table has a new index id, so on each commit it now checks whether the table's tablet changed
  (the catalog is updated before the commit listeners run); when it did, it takes the new index and wakes the
  loop, which drops its sleep until a job that is gone and reads the empty table. Jobs already running:
  - an action finishes; `completeJob` finds no document (an old id resolves to the new, empty table, since the
    number is the same) and records nothing;
  - a mutation job's commit conflicts with the replacement (its transaction read the old table's `_tables`
    row); the engine retries it, the retry's `unchanged` check finds the job gone, and nothing is written;
  - what such an action schedules is scheduled normally (its parent job is not found, not canceled), as Convex.

## 4. Divergences

None. (That Convex keeps the arguments in `_scheduled_job_args` and bunvex in the job is STUDY-30 S2, already
decided; it is not observable here.)

## 5. Tests

`packages/server/test/delete-scheduled-functions-table.test.ts`:

- one done job, one action in progress (held on a gate) and 2000 pending (1000 due in 400 ms, 1000 in an hour):
  the route answers 200 with no body, the table is empty at once; the action finishes and records nothing, no
  system error; past the due time nothing has run; a job scheduled afterwards runs at once (the executor
  watches the new table);
- a mutation job held mid-transaction: after the route it writes nothing, and runs once;
- the audit event: one `delete_scheduled_jobs_table` entry with `{component_id: null, component: null}`; an
  empty table replaced again writes a second one;
- a read-only key: 403 `OperationNotPermitted`; a `componentId`: `ComponentsNotSupported`; no key: refused;
  nothing deleted and no event in each case.

`packages/core/test/hidden-tables.test.ts`: `replaceWithEmptyTables` on `_scheduled_functions` (SQLite): `body`
runs once, the new table has the old number and indexes, old jobs and ids are gone, a new job works, and all of
it holds after a restart.

**Sabotage** (each alone, restored after; `git diff` clean):

| Sabotage | Caught by |
|---|---|
| executor never notices the new table (`now.id === -1`) | "every job goes at once" (the job scheduled afterwards waits) |
| the route replaces no table (`[]`) | "every job goes at once"; "a mutation job running meanwhile" |
| the hidden table gets another number (`number + 1`) | "every job goes at once"; "a mutation job"; "the audit event" |
| `ViewData` instead of `WriteData` | "WriteData required" |
| the component check never matches | "WriteData required … a component refused" |
| the audit event's action renamed | "the audit event" |
| the audit event's `component_id` set | "the audit event" |
| no audit event written | "the audit event" |

**Measurement.** The executor's commit listener gains one catalog lookup per commit. 20 000 sequential
mutations with the executor started, 7 runs each, alternating: median 37 353 and 56 787 commits/s on main
against 57 277 and 53 697 with the change; the runs vary by ±20 %, and no difference shows above that.

## 6. Open questions

None.
