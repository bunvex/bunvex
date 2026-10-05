# STUDY-118 — `bunvex deployment usage` and `usage-limits list|set|remove`

- **Status:** implemented (owner decisions, 2026-10-05: the `deployment` group; the metrics per DV-308)
- **Convex source read:** commit `4577b903` of get-convex/convex-backend
- **Related:** [STUDY-61](STUDY-61-usage-limits.md) (the server side: the meter, `/api/v1/*usage*`, the
  worker), DV-308, [platform §12](../parity/platform.md#12-cli-npx-convex-)

## 1. How Convex does it

`npm-packages/convex/src/cli/usageLimits.ts` holds the commands and `lib/usageLimits.ts` the API calls.
`deployment.ts` mounts them as `npx convex deployment usage` and `npx convex deployment usage-limits`. The group
takes the deployment selection options, which for self-hosted means `--url` / `--admin-key` / `--env-file` or
`CONVEX_SELF_HOSTED_*`. The `deploymentNotice` (" (on <type> deployment <name>)") is empty for self-hosted.

**API.** `usageLimitFetch` calls `/api/v1<path>` through `deploymentFetch`:

- `GET list_usage_limits` → `{ usageLimits }`;
- `GET get_current_usage` → `{ metrics: { <metric>: { unit, usage: { current_day, current_month } } },
  seedStatus }`;
- `POST create_usage_limit` and `POST update_usage_limit/<id>` with `{ metric, window, limitType, limit,
  enabled }` → `{ usageLimit }`;
- `POST delete_usage_limit/<id>`, with no body.

A failed request goes through `ThrowingFetchError.handle` (`lib/utils/utils.ts`). It prints
`✖ <status> <statusText>: <code>: <message>`, or only the server's message for a 403. It exits 1.

**Choices.**

- `--metric` takes the CLI's 8 metrics, in this order: `functionCalls`, `queryMutationComputeGbHours`,
  `actionComputeConvexGbHours`, `actionComputeNodeJsGbHours`, `actionComputeCpuGbHours`, `databaseIoGb`,
  `searchQueryGb`, `dataEgressGb`. The backend's `aiGatewayCostDollars` is not offered.
- Each metric has a label (`METRIC_LABELS`). An unknown metric shows its id.
- `--window` is `day|month` and `--type` is `warning|disable`.
- These are mandatory commander options. A missing one is `error: required option '--metric <metric>' not
  specified`. A bad one is `error: option '--metric <metric>' argument 'x' is invalid. Allowed choices are …`.

**Formatting.**

- `formatTable` draws a box with `┌┬┐ ├┼┤ └┴┘ │ ─`, one space of padding, and right alignment for chosen
  columns.
- Table amounts use `Intl.NumberFormat("en-US", { notation: "compact", compactDisplay: "short",
  maximumFractionDigits: 3 })`, with `-0` shown as `0`. The unit follows, and one call is `call`.
- Messages use exact amounts with separators (`1,000,000`).
- The usage percentage is `Math.round(current / limit * 100)`, formatted with separators. With no usage for
  the metric, the cell is `—`.

**`usage [--json]`.**

- With `--json`: `JSON.stringify(response, null, 2)` on stdout.
- Otherwise:
  - if `seedStatus !== "complete"`, the seed message goes to stderr;
  - the table goes to stdout: `Metric | Day | Month`, with the metrics in the CLI's order and unknown ones
    last.

**`usage-limits list [--json]`.**

- It fetches the limits and the usage in parallel. Each limit gets `currentUsage` (its window's usage, or
  `null`), `unit`, and `triggered = enabled && currentUsage !== null && currentUsage >= limit`.
- The limits are sorted by metric rank, then month before day, then warning before disable.
- With `--json`: those objects.
- With no limits: "No usage limits configured." on stderr.
- Otherwise:
  - the seed message when not complete;
  - the table `Metric | Window | Type | Limit | Current Usage | Active | Triggered`, with Limit and Current
    Usage right-aligned and `yes`/`no` cells.

**`usage-limits set --metric --window --type [--limit N] [--active|--inactive]`.**

1. Both `--active` and `--inactive`: `✖ error: Pass at most one of --active and --inactive.`
2. A `--limit` that is not an integer ≥ 1: `✖ error: --limit must be a positive integer, got "<value>".`
3. It then lists the limits and finds the one with the same (metric, window, type).
4. **None found:** without `--limit`, `✖ error: --limit is required when creating a usage limit.` Otherwise
   it creates the limit, enabled unless `--inactive`, and prints `✔ Created <type> usage limit on <label> per
   <window>: <limit>, active|inactive.`
5. **One found:**
   - `enabled` is `--active`, else `!--inactive`, else unchanged; the limit is `--limit`, else unchanged;
   - the changes are `limit A → B` and `active → inactive` (or back);
   - with no changes: `✔ No changes to <…> (<limit>, <state>).`;
   - otherwise it updates the limit and prints `✔ Updated <…>: <changes>.`

**`usage-limits remove` (aliases `rm`, `delete`) `--metric --window --type`.**

- No such limit: `✖ error: No <type> usage limit on <metric> per <window>.` The metric is its id here, not its
  label.
- Otherwise it deletes the limit and prints `✔ Deleted <type> usage limit on <label> per <window>.`

**The seed messages.**

- "Historical usage is still being loaded, so the usage shown below may understate this deployment's actual
  usage. Check back shortly for accurate totals." (`pending` / `partial`).
- "We couldn't load this deployment's historical usage, so …" (`failed`).

## 2. What an app can observe

Scripts and operators see:

- the commands and their options;
- stdout (tables, JSON) and stderr (everything else);
- the exit codes;
- the text above, character for character.

Self-hosted Convex reports `seedStatus: "pending"` (STUDY-61), so its CLI always prints the "still being
loaded" message.

## 3. How bunvex does it

`packages/cli/src/deployment.ts` is mounted as `bunvex deployment` (owner decision: the same group, so scripts
port 1:1).

- **Target.** `--url` / `--admin-key` / `--env-file` or `BUNVEX_SELF_HOSTED_*`, or the local deployment, as
  `bunvex env` does.
- **Requests.** Each request goes to the same routes with the `Bunvex` auth scheme. Failures print as Convex's
  `ThrowingFetchError` prints them.
- **Metrics.** The metric choices, labels and order are Convex's, with `actionComputeIsolateGbHours` in place
  of `actionComputeConvexGbHours` (DV-308). Its label is still "Action compute". The server's
  `aiGatewayCostDollars` shows by its id, last, as in Convex.
- **Formatting and messages.** The tables, number formats, ordering, messages and streams are Convex's, as
  listed in §1. The seed message prints because bunvex's server reports `pending`, as self-hosted Convex does.
- **Argument errors.** These follow bunvex's CLI convention: `bunvex deployment: <commander's text>`, exit 2.
  Convex (commander) prints `error: <text>` and exits 1. The same holds for every bunvex command; see §6.
- **Other `deployment` subcommands.** Convex's `create`, `select`, `token`, … manage its cloud and are not
  commands here.

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| — | The metric `actionComputeIsolateGbHours` | Rule 5 | DV-308 (owner, 2026-10-03) |

No new divergence. The argument-error convention is §6's question.

## 4b. Additions (beyond Convex)

None.

## 5. Tests

`packages/cli/test/deployment.test.ts`, against a running server:

- **Creating and updating with `set`.**
  - Creating without `--limit` fails.
  - Created: `1,000,000, active`.
  - Updated: `limit 1,000,000 → 2,000,000`, then `active → inactive`, then "No changes …".
  - A `--limit` alone keeps the state.
  - `--active` and a limit together give two changes.
  - `--inactive` on create gives `inactive`.
  - `--json` returns the stored limits.
- **The `list` table, character for character**, with recorded usage:
  - the order (metric rank, month before day, warning before disable);
  - compact amounts with units (`1.5K calls`, `1M calls`, `0 GB-hours`, `4 GB`);
  - percentages (`100%`, `75%`, `0%`), right alignment, `yes`/`no`, and triggered at the limit;
  - the seed message on stderr;
  - one `--json` row in full.
- **`remove`.** `remove`, `rm` (missing: Convex's error with the metric id, exit 1) and `delete`.
- **Argument errors.**
  - `--limit` values `0`, `-3`, `1.5` and `lots` give Convex's message;
  - `--active --inactive`;
  - a missing `--metric`;
  - `actionComputeConvexGbHours` is refused with the choices listed;
  - a bad `--type`;
  - options of another subcommand, and unknown subcommands.
- **Server errors.** `UsageLimitBelowCurrentUsage` prints as `✖ 400 Bad Request: <code>: <message>`. A 403
  (read-only key) prints the message alone.
- **The `usage` table**, every metric in Convex's order with `1 call` and `1.235M GB`. `--json` equals the
  server's answer, pretty-printed.
- **`formatTable` alone**, with right alignment.

There is no oracle against the `convex` package. Its CLI authenticates with the `Convex` scheme, which a
bunvex server refuses (DV-03), so the expected text is read from the source above.

Sabotage (each broke a test, then restored; `git diff` clean):

| Sabotage | Failed |
|---|---|
| day before month | list table |
| Current Usage left-aligned | list table |
| "1 calls" | usage table |
| triggered when above (not at) the limit, and when inactive | list table |
| an update without `--active`/`--inactive` re-enables | set |
| a fractional `--limit` accepted | argument errors |
| the missing-limit error names the label | remove |
| compact amounts with 1 fraction digit | usage table |
| a server error without its status and code | server errors |

## 6. Open questions

- **Argument errors (all of bunvex's commands, not only these).** Convex's commander prints `error: …` and
  exits 1. bunvex prints `bunvex <command>: …` and exits 2. This is not recorded as a divergence yet, and the
  owner may want a row for it.
