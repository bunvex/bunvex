# STUDY-61 — Usage tracking and usage limits

- **Status:** implemented; DV-308 resolved to match Convex, DV-309 accepted (owner, 2026-10-03)
- **Convex source read:** `main` of get-convex/convex-backend (4577b9031), 2026-10-03
- **Related:** [STUDY-63](STUDY-63-pause-deployment.md) (`_backend_state` and the stop checks this reuses),
  [STUDY-47](STUDY-47-log-streaming.md) (the function log's usage, DV-251 / DV-252),
  [STUDY-48](STUDY-48-audit-log.md) (audit events), STUDY-34 (`ViewUsage`, `ViewUsageLimits`,
  `WriteUsageLimits`)

## 1. How Convex does it

### 1.1 It runs in the open-source backend

- `local_backend` uses `NoOpUsageEventLogger` (usage events go nowhere) and a no-op limit notifier (no
  emails).
- `Application::new` still always wraps the logger in `UsageLimitRecorder`, which feeds an in-memory
  `UsageMeter`, and always starts `UsageLimitWorker`.
- The `/api/v1` routes are in the self-hosted router, and the self-hosted dashboard has a Usage Limits
  page.
- What self-hosted lacks is the cloud's history: the meter is never seeded (`seedStatus` stays
  `"pending"`) and starts at 0 on each start.

### 1.2 What is metered (`usage_limits/src/recorder.rs`)

- **`functionCalls`**: each tracked function call (system functions are not tracked), each storage call of
  an action, each HTTP storage call (upload, download).
- **Compute**, in GB·s = memory (MB) / 1024 × duration (s):
  - queries and mutations: `queryMutationComputeGbHours` (a cached query has duration 0);
  - actions and HTTP actions: `actionComputeConvexGbHours`, plus `actionComputeCpuGbHours` from the user
    time; Node actions: `actionComputeNodeJsGbHours`;
  - memory is 64 MB for isolate functions (`ISOLATE_MAX_USER_HEAP_SIZE`) and 512 MB for Node actions.
- **`databaseIoGb`**: each call's database bytes read and written (v2 counts).
- **`dataEgressGb`**: fetch, HTTP storage and action storage egress.
- **`searchQueryGb`**: text and vector search bytes searched.
- **`aiGatewayCostDollars`**: always 0 in the open-source backend.

### 1.3 Limits (`model/src/usage_limits`, `local_backend/src/usage_limits.rs`)

- **`_usage_limits`** (number 552, index `by_selector` = metric, window, limitType):
  `{metric, window: day|month, limitType: warning|disable, limit: int64 ≥ 1, enabled}`.
- **Windows** are the UTC calendar day and month.
- **Routes** (under `/api/v1`):

  | Route | Operation | Answer |
  |---|---|---|
  | `GET get_current_usage` | `ViewUsage` | `{metrics: {<metric>: {unit, usage: {current_day, current_month}}}, seedStatus}`, all nine metrics, in display units |
  | `GET list_usage_limits` | `ViewUsageLimits` | `{usageLimits: [{id, metric, window, limitType, limit, enabled}]}` |
  | `POST create_usage_limit` | `WriteUsageLimits` | `{usageLimit}` |
  | `POST update_usage_limit/{id}` | `WriteUsageLimits` | `{usageLimit}` |
  | `POST delete_usage_limit/{id}` | `WriteUsageLimits` | 200, no body |

- **Errors**:
  - 400 `InvalidUsageLimit` (limit 0);
  - 400 `DuplicateUsageLimit` (same metric, window and type);
  - 400 `UsageLimitBelowCurrentUsage` (enabled limits only; equal is allowed and trips at once);
  - 400 `InvalidId`;
  - 404 `UsageLimitNotFound`;
  - `UsageLimitWarningNotSupported` (development deployments only, so never on self-hosted).
- **Audit events**:
  - `create_usage_limit {id, config}`, `update_usage_limit {id, previous, current}`,
    `delete_usage_limit {id, config}`;
  - from the worker: `usage_limit_exceeded {id, config}` and `change_usage_limit_stop_state {old_state,
    new_state}`.

### 1.4 The worker (`usage_limits/src/worker.rs`)

- **When it runs**: every 10 s (`USAGE_LIMIT_EVALUATE_INTERVAL_SECS`) and on each change to
  `_usage_limits`.
- **What it does**, in one transaction (write source `usage_limit_enforcement`):
  - Each enabled limit whose window total is ≥ the limit is audited once per window, again only for a
    higher limit.
  - `_backend_state.usage_limit` becomes `disabled` while an enabled `disable` limit is reached, and
    `none` otherwise. Each change is audited.
- **While disabled**:
  - User functions fail with "This deployment has been disabled because it exceeded a configured usage
    limit. Update or disable the usage limit in the Convex dashboard in deployment settings to resume
    function execution.";
  - the scheduler and crons wait;
  - storage refuses (STUDY-63's checks).
- **Re-enabling** is automatic: a new window, or a raised, disabled or deleted limit. On self-hosted a
  restart resets the meter, and so re-enables.

## 2. What an app can observe

- The routes, their errors and audit events.
- `get_current_usage`.
- A deployment that stops once a `disable` limit is reached.
- `memoryUsedMb` in the function log.

## 3. How bunvex does it

- **`server/src/usage-limits.ts`**:
  - `UsageMeter` (the day and month totals);
  - the routes;
  - `UsageLimitWorker`.
- **`core/src/backend-state.ts`**: `setUsageLimitStopState`. The stop checks and the message come from
  STUDY-63.
- **Metering**:
  - `Functions` meters each logged completion, OCC retries included: compute from the function log's
    time and memory (64 / 512 MB, now also in the log's `memoryUsedMb`), and database I/O from its usage
    bytes.
  - The HTTP storage routes count calls and download bytes.
- **The meter**: this process's totals per UTC day and month, as self-hosted Convex. Day and month keys
  are numeric, so it costs nothing measurable per call.
- **The worker** runs every 10 s, after each limit change, and on start. Each pass is one mutation.

### Cost

Measured in process (30 000 calls × 3 rounds, through the function log): query ≈ 11 µs and mutation ≈ 24 µs
with and without the meter, within the noise. A first version that formatted dates per sample cost
+2.5 µs per query.

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| DV-308 | ~~The metric renamed `actionComputeIsolateGbHours`~~ — resolved: Convex's name, by an explicit rule-5 exception for wire names (`WIRE_NAMES`). The stop message stays reworded (rule 5). | — | owner, 2026-10-03 |
| DV-309 | Usage is metered from the function log. Database I/O uses its byte counts (DV-251: JSON lengths, no index key bytes). Search, fetch and action-storage bytes are not counted, nor system-function bandwidth. Action CPU equals action time (DV-252). | Ainda não fizemos: those counters are not measured. | accepted (owner, 2026-10-03) |

## 5. Tests

`server/test/usage-limits.test.ts`:

- **The meter**: UTC day rollover (a new day at 0, the month going on), a late sample (not today's, still
  this month's), compute in GB·s for mutations and actions (CPU from the user time).
- **`get_current_usage`**: the nine metrics in order, units, counts, `seedStatus`, a read-only key.
- **Limit API**:
  - create, list, update and delete with Convex's shapes;
  - duplicate, zero limit, bad metric, operation;
  - below current usage (enabled only);
  - bad id, not found;
  - the audit trail (`previous` and `current`).
- **Enforcement**:
  - a warning only reports;
  - a reached `disable` limit stops the deployment, and functions fail with the message;
  - raising the limit enables it again;
  - the four audit events in order.
- **Storage and the log**: HTTP upload and download as calls, and the download's bytes as egress;
  `memoryUsedMb` is 64.
- **Sabotage checks**, each failing a test:
  - the day reset, the late drop;
  - `disable` vs `warning`, enabled-only;
  - once-per-window reporting, audit on change only;
  - below-current (and enabled-only);
  - duplicates, CPU compute;
  - the stop message, the recording hook, the memory.
