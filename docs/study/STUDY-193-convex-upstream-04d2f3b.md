# STUDY-193 — Convex up to precompiled-2026-10-26-04d2f3b, and STUDY-186's build status
<!-- index: Convex from `precompiled-2026-10-24-bb31399` to `precompiled-2026-10-26-04d2f3b`, triaged; STUDY-186 A1–A19 status; the reference move planned | decided (owner, 2026-10-26): oracle first, `convex` 1.48.0 -->

- **Status:** decided; PR 1 (the oracle, A14 and the client pin) is built (§5.4). The owner took both §6 recommendations on
  2026-10-26.
- **Convex source read:** get-convex/convex-backend from the release tag `precompiled-2026-10-24-bb31399` (the end
  of [STUDY-186](STUDY-186-convex-after-72ce13c.md)) to the release tag `precompiled-2026-10-26-04d2f3b`
  (2026-10-26). That is 3 commits. `scripts/upstream-triage.ts` sorts one as weekly (dashboard) and ignores two (docs).
  All three were read with `git show`. No crate, `npm-packages/convex`, system UDF or node-executor file changes in
  the range (`git diff --stat` touches three files, all docs or dashboard). So the two releases' binaries behave the
  same, and the `convex` npm package is still 1.48.0.
- **bunvex code read:** `main` at `a90013ff` (after #878).
- **Process:** the weekly bump of [STUDY-138](STUDY-138-following-convex.md) and
  [upstream.md](../parity/upstream.md). The reference is still at `precompiled-2026-10-10-72ce13c`; PR 1 moved the
  oracle to `04d2f3b` (§5.4).
  STUDY-186 triaged up to `bb31399` and left the move for later. This study plans the move straight to `04d2f3b`.
- **Related:** [STUDY-186](STUDY-186-convex-after-72ce13c.md) (the previous triage and its A1–A19),
  [STUDY-173](STUDY-173-convex-reference-2026-10-10.md) (the last reference move),
  [STUDY-185](STUDY-185-olap-s3-iceberg.md) (A13, A14). STUDY-192 covers `ctx.auth.signJwt` and
  `/.well-known/jwks.json` (STUDY-186 §4.2), and this study leaves both out. STUDY-194 is STUDY-24 A2's execution
  protocol and is unrelated.

## 1. How Convex changed

Nothing an app observes changed. Two commits document behaviour that STUDY-186 already triaged:

- **`04d2f3b`, the log line limits page.** It now says 32 KiB per `console.log` line, 256 lines per query or
  mutation, and 1024 per action. The 1024 and 256 are `04e9983` + `0e4f90d`, which is STUDY-186 A1. The 32 KiB is
  not new. `MAX_LOG_LINE_LENGTH = 32768` has been in `crates/common/src/log_lines.rs` and
  `crates/isolate/src/environment/helpers/mod.rs` since 2024, and the docs said 4 KiB until now. bunvex already
  cuts at 32768 UTF-8 bytes (`server/src/logs.ts:23`, `sandbox/src/host-call.ts:269`).
- **`b4446ed`, `function.runtime` in log stream events.** It documents `runtime` on `console` and
  `function_execution` events: `"convex"` or `"node"`, and `null` for an action that failed with a system error
  before it started. This is `868554b`, which is STUDY-186 Q4, decided as DV-552 (`"bunvex"` in place of
  `"convex"`). The docs' `null` case matches DV-552's wording.

The third commit, `4d66d67`, adds a cloud dashboard billing helper (`usageSpend.ts`, spending from metric prices).
bunvex's dashboard has no billing page.

**signJwt.** None of the 3 commits touches `signJwt`, `deployment_jwt.rs` or `/.well-known/jwks.json`
(`git log -S signJwt`, `git log -S jwks.json` and a path filter on `*deployment_jwt*`, all empty). STUDY-192 has
nothing to add from this range.

## 2. What an app can observe

No new behaviour. Once STUDY-186's §4.1 is built, an app sees the same thing on bunvex as on
`precompiled-2026-10-26-04d2f3b`. The exceptions are the two mutation features: storage in mutations, and signJwt
(STUDY-192). §3 lists what is still missing.

## 3. STUDY-186 A1–A19: what is built

Searched on `origin/main` (`a90013ff`): the code, the tests, the parity rows, `git log` and the merged PRs (#836
merged STUDY-186 on 2026-10-26; every PR merged since was read by title, and the ones that mention STUDY-186 were
opened). Two of the nineteen items are built.

| # | Item | Built | PR | Evidence on `main` |
|---|---|---|---|---|
| A1 | Log lines: 1024 for actions, 256 for queries and mutations | no | — | one `MAX_LOG_LINES = 256` for every function (`server/src/logs.ts:21`; the child's copy, `sandbox/src/child-call.ts:588`) |
| A2 | Import limits: 64 MiB part, 16 MiB JSONL line and CSV record | no | — | `/api/import/upload_part` reads any size (`server/src/server.ts:2233`); `import-parse.ts` has no line or record bound |
| A3 | Drop the 90 MB zipped package limit | no | — | `MAX_ZIPPED_PACKAGE_BYTES = 90_000_000` and its knob (`server/src/code-store.ts:40-49`) |
| A4 | PBKDF2 cap at 150 000 000 work units | no | — | no cap or "too many iterations" in `core/src/determinism.ts` |
| A5 | 204/205/304 with a body throws | no | — | `SpecResponse` has no null-body status check (`server/src/web-response.ts:63`), and Bun 1.4.4's `Response` accepts all three (probed: `new Response("x", {status: 204})` does not throw) |
| A6 | Action `fetch` drops the app's `Proxy-Authorization` | **yes** | #842 | `request.headers.delete("proxy-authorization")` (`server/src/action-fetch.ts:311`) |
| A7 | `.staged({ field })` field deltas | no | — | an object is still taken as the whole validator (`core/src/schema.ts:336-341`) |
| A8 | `paginate()` in component queries | no | — | "paginate() is only supported in the app." (`core/src/tx.ts:1751`) |
| A9 | Data sync: no hidden tables, by-ts fallback, page 20 000 | no | — | page `16384` (`server/src/data-sync.ts:43`); the selection still takes "active and hidden user tables" (`:292`) |
| A10 | Resume a backfill at a fresh snapshot, keeping the count | no | — | past retention, the backfill starts over from `FULL_LO` with `done = 0` (`core/src/index-worker.ts:281-290`) |
| A11 | Mutation permit before the transaction | no | — | the permit is taken inside `perAttempt`, after the transaction began (`server/src/functions.ts:1967`) |
| A12 | Audit log: integration configs, `download_export` | no | — | integration events carry `{id, type}` only (`server/src/audit-log.ts:86-88`); no `download_export` |
| A13 | S3 export API: `FieldFiltersUnsupported`, frozen destination, in-transaction check | **yes** | #862 (+#881) | `FieldFiltersUnsupported` (`server/src/log-sinks-routes.ts:266`); differential `s3-export-api.test.ts`, which #881 skips against an oracle older than `precompiled-2026-10-24` |
| A14 | `_s3_export_state`, `DATABASE_VERSION` 134 | **yes** (PR 1) | PR 1 (§5.1) | `DATABASE_VERSION = 134n`; `_s3_export_state` (number 556, `by_config_id` on `configId`) in `core/src/catalog.ts` and the engine's system tables; `listConfiguredSinks` adds its `exportProgress`. `cross-open.test.ts` checks that neither binary warns or migrates |
| A15 | Refuse Node 20 | no | — | `"20"` accepted (`server/src/push.ts:315`) |
| A16 | `env list --include-values`; MCP `envList` names by default (and DV-551's agent default) | no | — | only `--names-only` (`cli/src/env.ts:30-36`); MCP `envList` returns values (`cli/src/mcp-tools.ts:347`) |
| A17 | Validate `--local-backend-version` | **yes** | #892 | `isValidBackendVersion` / `assertValidBackendVersion` before `ensureBinary` and `ensureDashboardDownloaded` use it (`cli/src/local-deployment.ts`, `local-dashboard.ts`) |
| A18 | Source-mapped push errors past the line's end | no | — | the context block is printed whatever `original.col` is (`server/src/definition-eval.ts:257`) |
| A19 | `FunctionHandle_future` type | no | — | not exported (`server/src/index.ts:141` exports `FunctionHandle` only) |

None is partly built. A14 is "no" on purpose: STUDY-186 and #862 tie it to the reference move.

The rest of STUDY-186 was checked too:

| STUDY-186 item | Built | Evidence |
|---|---|---|
| §4.3, a V8 action's `setTimeout` past 2^31−1 ms | **yes**, #839 | "a V8 action's timer past 2^31-1 ms waits its whole delay" |
| Q2 / DV-551, `env list` names only for AI agents | no | goes with A16; DV-551 says "to be built" |
| Q3, the local dashboard's empty 403 on every non-loopback `Host` | no | only `/api/current_deployment` is checked, with a worded body (`cli/src/dashboard-server.ts:166-168`); DV-476 not yet moved |
| Q4 / DV-552, `function.runtime` in log stream events | no | `log-events.ts` has `runtime: "default" \| "node"` only on the function's metadata, nothing on the stream event; DV-552 says "to be built" |
| Q5, the MySQL retry set | no | `LOST` still holds `EPIPE`, `ETIMEDOUT`, `EHOSTUNREACH`, `ENETUNREACH`, and no `EAI_AGAIN` (`persistence/src/mysql.ts:209-218`) |
| Q6, Bun's Brotli and root store (outside parity) | no record | no doc or commit mentions the check |
| §4.2, storage in mutations (study) | no study yet | — |
| §4.2, signJwt and JWKS (study) | in STUDY-192 (draft #882) | another session |
| §4.2, CLI staged-schema output (`4f81b22`) | no | `--allow-unstaging-schema` is not in `cli/src` |
| §4.2, `v.function()` | waits for Convex's client | — |

## 4. Every commit

Classes and actions as in [STUDY-186 §3](STUDY-186-convex-after-72ce13c.md#3-every-commit).

| Commit | Subject | Script | Class | bunvex | Action |
|---|---|---|---|---|---|
| `b4446ed` | docs: `function.runtime` in log stream events | ignored | docs-only | documents `868554b`; DV-552, not yet built (§3) | none (DV-552's PR builds it) |
| `4d66d67` | dashboard usage spending from metric prices | weekly | dashboard (cloud billing) | no billing page | none |
| `04d2f3b` | docs: log line limit increase | ignored | docs-only | documents `04e9983` + `0e4f90d` (A1); 32 KiB a line already matches (`server/src/logs.ts:23`) | none (A1 builds it) |

By category: align 0, new feature 0, owner question 0, none 3.

## 5. The plan

### 5.1 The PRs, in order

Each PR has a test that is red before and green after, and a sabotage check. Where the binary can show the
behaviour, it also gets an oracle case. There are no new align items from this range. The work is STUDY-186's
remaining items plus its decided owner answers.

The order puts the oracle move first (Q1). The PRs after it can then add oracle cases against the release they
align to, and STUDY-192's implementation is unblocked.

| Order | PR | Contents | Size |
|---|---|---|---|
| 1 | **Oracle and store at `04d2f3b`** (§5.2) | A14, the download script, the `convex` client pin (Q2), and the differential tests that change (§5.3) | medium |
| 2 | A1 | log line limits per kind, V8 and `"use node"` | small |
| 3 | A5 | null-body statuses in `SpecResponse` | small |
| 4 | A15 | refuse Node 20 | small |
| 5 | A3 | drop the zipped limit and its knob | small |
| 6 | A4 | the PBKDF2 cap | small |
| 7 | A17 | validate `--local-backend-version` (also closes a path traversal) | small |
| 8 | A18 | the source-map context fallback | small |
| 9 | A19 | `FunctionHandle_future`, with an api-shapes line (once the client pin allows it, Q2) | small |
| 10 | A2 | import part, JSONL line and CSV record limits | small–medium |
| 11 | A9 | data sync: hidden tables, by-ts fallback, page 20 000 | medium |
| 12 | A12 | audit log integration configs and `download_export` | medium |
| 13 | A16 + DV-551 | `--include-values`, MCP `envList`, the agent default | medium |
| 14 | A7 | `.staged()` field deltas | medium |
| 15 | A8 | `paginate()` in component queries (STUDY-154 rows) | medium |
| 16 | A10 | backfill resume at a fresh snapshot, with its note (STUDY-174 S1) | medium |
| 17 | A11 | the mutation permit before the transaction, measured under contention | medium |
| 18 | DV-552 | `function.runtime` on `console` and `function_execution` events | small |
| 19 | Q3 (DV-476) | the local dashboard's empty 403 on every path for a non-loopback `Host`; DV-476 resolved | small |
| 20 | Q5 | the MySQL retry set as Convex's | small |
| 21 | **Reference at `04d2f3b`** (§5.2) | upstream.md, the parity headers, the changeset | small, docs |

These items keep their own studies and are outside the bump's PR list: storage in mutations, signJwt (STUDY-192,
whose implementation depends on PR 1), the CLI staged-schema output, and `v.function()`. Q6's check of Bun's Brotli
and root store sits outside parity.

If the owner keeps STUDY-186's order (the move last, with every item aligned), PR 1 and PR 21 become one, and it
goes last. STUDY-192's implementation then waits for all of them.

### 5.2 What the move must include

PR 1, the oracle and store:
- `packages/differential/scripts/download-convex-backend.sh`: `TAG` defaults to `precompiled-2026-10-26-04d2f3b`.
- **A14.** `DATABASE_VERSION = 134n` (`core/src/database-globals.ts`). `_s3_export_state` goes in the catalog
  (`core/src/catalog.ts`), with the fields and indexes of Convex's table at `ea8497f`. A Convex 134 store must open
  with no "newer" warning. A 133 store must be refused like any older version, since bunvex keeps no paths for older
  stores (CLAUDE.md). `cross-open.test.ts` checks both directions. The `core/test/convex-rows` fixtures are
  regenerated from the new binary where `_db` or `_tables` changed.
- `exportProgress` in `listConfiguredSinks`, if the table carries it (#862's "Left open"). It is always absent while
  bunvex runs no S3 export worker (DV-571).
- The `convex` npm pin in `packages/differential/package.json` and `bun.lock` (Q2).
- `s3-export-api.test.ts`: its comment and its `RELEASE` guard now name an oracle that is current.
- Every differential test that the move changes (§5.3), fixed in bunvex or marked with its pending item.

PR 21, the reference (after the last align item, or merged into PR 1 if Q1 keeps STUDY-186's order):
- [upstream.md](../parity/upstream.md): the reference commit, the oracle, "Last weekly bump: STUDY-193", and
  "After the reference" cleared, except for what is carried.
- Parity headers that name `72ce13c`: `docs/parity/README.md`, `client-sync.md`, `platform.md`, `server-api.md`
  (their header lines only; STUDY-192's #882 edits rows in `server-api.md` §12 and `platform.md` §1, which this
  leaves alone). The rows each align PR changed are already updated in that PR.
- A changeset like `.changeset/convex-ref-2026-10-10.md`, naming the release.
- Test comments that cite "at 72ce13c" as the commit they were read at (`http-action-end.test.ts`,
  `noop-writes.test.ts`, `server/test/action-end.test.ts`) stay as they are. They record where the code was read,
  not the oracle.

### 5.3 The differential suite at `04d2f3b`

The whole suite was run against the downloaded `precompiled-2026-10-26-04d2f3b` (aarch64-apple-darwin), on `main` at
`a90013ff`, with the `convex` 1.46.0 client: **502 tests in 75 files, 0 failed, 0 skipped**, in 406 s. Today's tests
do not cover any STUDY-186 item still missing, so the move alone makes no test fail. Two tests change meaning:

- **`s3-export-api.test.ts`** stops skipping. Against `72ce13c` its `RELEASE` guard (#881) skips it. Against
  `04d2f3b` it runs and passes, which confirms A13 (#862) against the release it follows.
- **`cross-open.test.ts`** passes, but with a version gap. The binary's store is at `DATABASE_VERSION` 134 and
  bunvex reads 133, so bunvex opens it with the "newer" warning (DV-418). Convex migrates bunvex's 133 store to 134
  when it opens it. A14 closes the gap. The order is forced: A14 must not land before the oracle moves. A bunvex at
  134 refuses `72ce13c`'s 133 store, so `cross-open` fails against the old oracle. A14 and the download script
  therefore share PR 1.

The tests that will change later are the oracle cases the align PRs add: one per item where the binary shows the
behaviour (A1, A2, A3, A5, A7, A8, A9, A12, A15, A18, DV-552, through a webhook sink as `log-stream-egress.test.ts`
does). Each is red against bunvex until its PR. Moving the `convex` pin to 1.48.0 (Q2) moves `api-shapes`,
`component-definitions` and `table-definition-shape` onto 1.48.0's types. Whether they still agree was not run here.
PR 1 runs them, and A19 adds `FunctionHandle_future`.

### 5.4 PR 1, as built

- The download script fetches `precompiled-2026-10-26-04d2f3b`; upstream.md's oracle line names it (the reference
  line waits for PR 21).
- A14 as Convex's `ea8497f`, with `9ff64aab5`'s change (the checkpoint keeps `progress` only, no `cursor`). Convex
  numbers the table 44 (`DefaultTableNumber::S3ExportState`), so 556, and its index `by_config_id` is
  `["configId", "_creationTime"]`. Convex's migration to 134 is empty: its bootstrap creates the table, and so does
  bunvex's start. A 133 store is now refused, bunvex's own included: bunvex keeps no paths for older stores (CLAUDE.md),
  and DV-418 refuses an older version. An app moves its data by export, then import.
- `exportProgress` in `listConfiguredSinks`, from the export's `_s3_export_state` row when there is one. bunvex never
  writes one (DV-571), so it shows only in a store Convex's worker wrote.
- `convex` 1.48.0 in the differential suite, and `sync-e2e` at exactly 1.46.0. `api-shapes` fails on 1.48.0's
  `StorageWriter`, which now has `get` and `store` (storage in mutations, DV-437, §4.2 above): those two checks name the
  two methods and check one way until that item is built. `component-definitions` and `table-definition-shape` agree.
- `cross-open.test.ts` now reads each binary's output (Convex's logs go to stdout, which the harness used to drop):
  neither prints the "newer" warning, and Convex runs no migration. With bunvex at 133 both directions fail.
- `s3-export-api.test.ts` runs against the new oracle and passes.
- The whole differential suite against `04d2f3b` (aarch64-apple-darwin) with the 1.48.0 client: 502 pass, 0 fail,
  0 skipped, in 373 s.

## 6. Owner questions

Decided (owner, 2026-10-26): both as recommended.

| # | Question | Recommendation (decided) |
|---|---|---|
| Q1 | STUDY-186 says the reference and the oracle move "with the PR that aligns §4.1". So the move waits for all 17 remaining items, and every oracle case those PRs could add (and STUDY-192's) waits too. Split the move: the oracle and A14 first (PR 1), the reference line in upstream.md last (PR 21)? | **Split.** The oracle is a test tool. The reference is the claim that bunvex matches a release. Moving the oracle first lets each align PR prove itself against the binary it follows. The claim moves only once it is true. The move costs nothing today: the whole suite passes against `04d2f3b` (§5.3). A14 has to ship with the oracle move anyway (§5.3). |
| Q2 | The differential suite pins `convex` 1.46.0, the floor CLAUDE.md names. The oracle release ships 1.48.0, and A7 (`.staged()` deltas), A19 (`FunctionHandle_future`) and the two mutation features exist only there. Move the pin to 1.48.0? | **Move it to 1.48.0 with PR 1.** The oracle's own CLI is then the one it ships with, and the 1.48 surface can be compared. `api-shapes`, `component-definitions` and `table-definition-shape` compare against the installed `convex`, so they move to 1.48.0 too, which is what Convex ships at the reference. The 1.46.0 floor stays tested by pinning `sync-e2e`'s `^1.46.0` to exactly `1.46.0` (both now resolve to 1.46.0 in `bun.lock`). |

## 7. Tests

None in this study: it is a triage. Each item in §5.1 comes with its own tests and a sabotage check.

- **Run for this study:** `bun run test:differential` against `precompiled-2026-10-26-04d2f3b`, with
  `CONVEX_RELEASE=precompiled-2026-10-26-04d2f3b bash packages/differential/scripts/download-convex-backend.sh`.
  Result: 502 pass, 0 fail (§5.3). The script's default was not changed: that change is PR 1.
- **Probed:** Bun 1.4.4's `Response` accepts a body with status 204, 205 and 304 (A5 is still needed).
