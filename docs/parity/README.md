# Convex parity

bunvex is a rewrite of Convex for Bun: an app should work the same on both. This directory lists **everything
Convex has**, read from its source (get-convex/convex-backend @ `4577b9031`, brought up to the release `precompiled-2026-10-07-d8bdde0` by [STUDY-137](../study/STUDY-137-convex-reference-2026-10-07.md); how it is kept current: [upstream.md](upstream.md)), and where bunvex stands on each
item. It is the project's to-do list at the scale of the whole product.

| Area | File | Done | Partial | Missing |
|---|---|--:|--:|--:|
| Function and database API: `ctx.db`, queries, validators, values, schema, limits | [server-api.md](server-api.md) | 238 | 2 | 6 |
| Clients, sync protocol, reactivity, React, HTTP client | [client-sync.md](client-sync.md) | 163 | 1 | 1 |
| Platform: auth, storage, scheduler, crons, search, HTTP actions, CLI, deploy, import/export, system tables | [platform.md](platform.md) | 226 | 21 | 13 |

Beyond Convex, [additions.md](additions.md) lists 29 additions: 26 built (11 of them dashboard screens on the
mock, 3 more with their dashboard part on the mock), 2 accepted, 1 deferred, none proposed (2026-10-11, with AD-29).

These counts were recounted on 2026-10-12 (the docs audit: cloud-only and decided no-build rows re-marked *n/a*) from each row's status column: a row counts as done,
partial or missing by the word its status starts with. Rows marked *n/a* (cloud-only or a decided divergence)
are not counted: 1 in server-api.md, 1 in client-sync.md, 6 in platform.md.

## How to use it

- **Every PR that adds or changes a Convex feature updates the matching rows** in the same PR.
- A row goes from *missing* to *done* only with the study (`docs/study/`) and tests.
- Rows marked **Divergence?** in their notes are places where bunvex might deliberately differ. The owner
  decides them; until then, the default is to match Convex.
- **Every decided divergence gets a row in [divergences.md](divergences.md)**, the central ledger of what
  bunvex does differently from Convex and why. A PR that decides, changes or resolves one updates it.
- **Every addition (what bunvex adds and Convex does not have) gets a row in [additions.md](additions.md)**
  (`AD-NN`), proposed in a study and decided by the owner like a divergence.
- **Statuses:**
  - **done** means it matches Convex's behaviour.
  - **partial** means it exists but differs, and the note says how.
  - **missing** means it is not there.
- **Where Convex's code and docs disagree**, the code wins. Known cases are noted in the rows: indexes per
  table are 64 in the code and 32 in the docs; log lines are 32 KiB in the code and 4 KiB in the docs.

## Roadmap

The order follows one principle: **first make what exists correct, then make the core behave like Convex,
then grow outwards.** Each item becomes one or more PRs, each with its study.

**Where it stands (checked against the parity rows on 2026-10-12):** phases 0, 1 and 2 are done. Phase 3 is done
except the dashboard on a real deployment (item 12) and built-in auth (item 13). In phase 4, search, vector search,
log streaming, metrics, streaming export and Node's `externalPackages` are done; components remain.

### Phase 0 — correctness bugs in what already exists

**Done.** Every bug below is fixed.

Found by the retroactive studies (STUDY-05 … STUDY-11). They are not divergences to decide: bunvex is
wrong.

| # | Bug | Study |
|---|---|---|
| B1 | **Fixed in #8.** Four of the five drivers over-fetch a fixed `limit × 2–4` rows without paging, so old versions and deleted entries can make `take`/`first` return short or `null` | STUDY-09 D1/D2 |
| B2 | **Fixed in #9** (fail-stop, as Convex). A failed `flush()` rejects the mutation, but its writes become visible (and durable, on SQLite) anyway | STUDY-06 D1 |
| B3 | **Fixed in #9.** An exception thrown by `persistence.apply` wedges the committer forever | STUDY-06 D2 |
| B4 | **Fixed in #17** (keys split into `key_prefix` + `key_suffix` + sha256, as Convex; conformance K9). Long index keys fail the flush: MySQL `varbinary(512)`, Postgres btree ~2.7 KB. Convex splits keys into prefix + sha256 | STUDY-09 D3 |
| B5 | **Fixed in #10** (with the implicit `_creationTime` and sub-ms creation times). `withIndex` ignores field names: wrong or out-of-order fields silently return every row | STUDY-05 D2/D5, STUDY-07 D3 |
| B6 | **Fixed in #21.** Missing fields are indexed as `null`, where Convex indexes them as `undefined`; `eq(f, undefined)` throws | STUDY-05 D4 |
| B7 | **Fixed in #21.** NaN, ±Infinity, −0, `undefined` in arrays and `Date` are changed by `JSON.stringify`, so the stored document and its index keys disagree | STUDY-10 D1 |
| B8 | **Fixed in #11.** Subscriptions can get stuck after an error: no re-send when the value returns to its pre-error value; never re-run if the first run throws | STUDY-08 D1/D2 |
| B9 | **Fixed in #13.** Values are not copied at the call: mutating an object after `insert`, or a `get` result, changes what is stored | STUDY-10 D3 |
| B10 | **Fixed in #13.** The query cache hands out results by reference: a caller mutating a result corrupts it for others | STUDY-08 D3 |
| B11 | **Fixed in #21.** Objects, arrays and bytes are not encodable in index keys (all objects encode equal) | STUDY-05 D6 |
| B12 | **Fixed in #12** (with Convex's transaction read limits). `collect()` is silently capped at 8192 rows; `take(0)` or a negative `take` misbehaves on the memory driver | STUDY-07 D1/D2 |
| B13 | **Fixed (STUDY-27).** Once `ctx.auth` exists, cache and subscription keys would serve one user's results to another. The query cache and sync's shared executions key a result by identity only when the run read it | STUDY-08 D6 |
| B14 | **Fixed in #11.** One socket subscribing twice to the same key leaks a reference count | client-sync.md |
| B15 | **Fixed in #107 and #112** (call timeouts; transient flush and read retries, as Convex; conformance K20/K21). No timeouts on database calls, no retry of transient flush errors, no retry of reads: a hung connection stalls the process, a network blip kills it. Match Convex (owner, 2026-10-01; DV-104–DV-106) | STUDY-25 L3–L5 |
| B16 | **Fixed in #114.** No stored layout version and no `read_only` flag: a foreign or future store fails obscurely. Match Convex (owner, 2026-10-01; DV-107, DV-108) | STUDY-25 L6/L7 |
| B17 | **Fixed (this PR).** A deployable server served before its deployed code was loaded: right after a start, an HTTP call, a sync query or an HTTP action got "Could not find public function", a scheduled job due meanwhile was failed for good, and a due cron logged a missing function. Calls now wait for the code; the scheduler and crons start once it is loaded (Convex serves once its application is built, and loads modules on demand) | STUDY-136 §3.5 (found by its benchmark) |

### Phase 1 — the core behaves like Convex

**Done.**

1. **Values:** `@bunvex/values` with every `v.*` validator, `args`/`returns` checking, Int64/bigint,
   bytes, Convex's cross-type value order and the `$integer`/`$bytes`/`$float` JSON encoding — done (#24, #25,
   #21, STUDY-18).
2. **Index keys:** the implicit `_creationTime` before `_id` in every user index, `undefined`, and nested
   field paths — done (#10, #21, STUDY-05).
3. **Documents:** field-name rules, system fields refused in writes, `replace`, `NonexistentDocument`, and
   the size, nesting, array and field-count limits — done (#21, #35).
4. **Queries:** `filter` and its builder, `unique`, `paginate` (cursors, `endCursor`, `maximumRowsRead`),
   async iteration, the transaction read/write limits, and a read-set narrowed to what `take` read — done
   (#37, #40, #42, #134, DV-57).
5. **Transactions:** Convex's OCC retry budget and error, the 1 s execution limit, and `db.vars.commitTs` —
   done (STUDY-21, STUDY-41, STUDY-53).
6. **Function results:** `ConvexError` data, error redaction, status codes, `logLines` — done (STUDY-20, as
   `BunvexError`; cached query lines DV-74, subscription lines DV-75).
7. **Schema:** `defineSchema`/`defineTable`, document validation, `schemaValidation`, staged indexes, and
   tables created on first insert — done (#29, #33, STUDY-29, STUDY-106).

### Phase 2 — sync protocol and clients

**Done.**

Protocol v1:

- all queries advance together (Transition with state versions) — done (STUDY-23);
- read-your-writes (the mutation commit ts) — done (STUDY-23, STUDY-26);
- mutation ordering per connection — done (STUDY-22);
- idempotency (session and request ids) — done (STUDY-23);
- reconnect and resend, auth messages — done (STUDY-26, STUDY-27).

Then `@bunvex/client` (base client, reconnect, backoff, optimistic updates, reactive pagination) and
`@bunvex/react` (`ConvexProvider`, `useQuery`, `useMutation`, `usePaginatedQuery`, auth helpers) — done
(STUDY-26, STUDY-27), with `@bunvex/nextjs` (STUDY-46), `@bunvex/react-clerk` / `@bunvex/react-auth0`
(STUDY-54) and `@bunvex/react-query` (STUDY-55).

### Phase 3 — platform

In this order:

1. auth (OIDC and custom JWT, `ctx.auth`) — done;
2. scheduler and crons (STUDY-30) — done;
3. HTTP actions (STUDY-31) — done;
4. file storage (STUDY-32; it uses HTTP actions for uploads and downloads; built-in auth, STUDY-28, needs them
   too — swapped with HTTP actions by the owner, 2026-10-01) — done;
5. retention and garbage collection of old versions (STUDY-33) — done;
6. admin keys (STUDY-34) — done;
7. pushing and deploying functions (STUDY-35): module loading, hot swap in `vm` contexts, the pushed code
   kept in the store, the deploy2 protocol, `bunvex deploy` — done;
8. codegen (`_generated/api`, `server`, `dataModel`; ARCH-01 open decision 1, decided: generate like Convex;
   STUDY-36) — done, with Convex's flags (STUDY-116);
9. the CLI, part 1: `start`, `deploy`, `dev`, `run`, `admin-key`, and environment variables (`process.env`,
   `env set|get|list|remove`) — built (STUDY-37); `dev`, `deploy` and `run` are partial (platform §12);
10. the Docker image and docker-compose (credentials bootstrap), so a self-hosted app can be brought up as
    with Convex — done (STUDY-38, STUDY-40);
11. `ctx.runQuery` / `ctx.runMutation` inside queries and mutations, and the 1 s user execution limit
    (STUDY-41) — done, with N2, N3 and N6 built in #213;
12. the dashboard on a real deployment (its HTTP data source, with the UI session, and the `_system/*`
    functions it reads), then live logs — open: every screen is built on the mock; the server source,
    `@bunvex/dashboard-source`, is being built in steps (STUDY-149: PR 1 reads the deployment, schema, state,
    logs and function metrics);
13. built-in auth (STUDY-28) phases — open (AD-01 accepted, spike done);
14. import/export in Convex's snapshot format, so data can move between Convex and bunvex (STUDY-42) —
    done; shape inference and the upgrade path remain (platform §18; cloud backups are cloud-only, *n/a*).

Items 7–12 were ordered by the owner on 2026-10-01 to reach a self-hosted example app end to end (bring the
containers up, deploy functions, see them work) before the remaining platform items.

### Phase 4 — the rest

- full-text search (STUDY-45, STUDY-111: all 10 rows done, platform §6) and vector search (STUDY-51: all 6
  done, §7) — done;
- components (1 of 7, §11; DV-55, plan in STUDY-62) — open;
- Node actions: `"use node"` runs in Bun (DV-87) — done; `node.externalPackages` — done (STUDY-148; DV-470–DV-473
  decided by the owner, 2026-10-12);
- log streaming (STUDY-47, STUDY-59, STUDY-70) and metrics (§20: 14 done; insights is cloud-only, *n/a*) —
  done;
- streaming export (STUDY-60, STUDY-69) — done;
- the dashboard's connection to a real deployment. Every screen is built on the mock (UI-01 §0, platform §21);
  the server source (`@bunvex/dashboard-source`, STUDY-149) reads the deployment, schema, state, logs and
  function metrics so far; the tables, documents, functions and other screens, and the app's switch to it,
  are still to come.

## Gaps by impact

Checked against main on 2026-10-04, after #370–#395. Since the first ranking, these were built: the action
timeout (#371), searches while indexes rebuild (#375), `server-only` and wasm bundling (#376),
`deploy --cmd` (#378), the `log` export (#380), the write-throughput limit (#374), the SSRF proxy
(#377–#381), identical database indexes refused (STUDY-66), the sync arguments-size metrics
(`bunvex_sync_*_args_bytes`, #432; its client-sync row marked done 2026-10-11), the CLI's `network-test`, `docs`, `update` and `dashboard` (STUDY-146), the remaining `bunvex.json` keys (`node.nodeVersion`, `bundler.includeSourcesContent`, STUDY-145), the upgrade guide ([docs/upgrading.md](../upgrading.md)). Decided divergences and cloud-only items are not
gaps.

**High: an app that uses it does not run**

1. **Components** (DV-55, decided to match Convex; plan in [STUDY-62](../study/STUDY-62-components.md)):
   `convex.config.ts`, `defineApp` / `defineComponent`, table and function namespaces, `components.*`
   references and their codegen, component HTTP mounts and env. Any app on `@convex-dev/*` components
   (rate limiter, aggregate, workpool, auth, …) cannot run.

**Medium: an app hits it in normal use of a feature**

2. **Auth helpers:** no Convex Auth (`@convex-dev/auth`, itself a component) or WorkOS AuthKit equivalent;
   Clerk and Auth0 exist (platform §1).
3. **`node.externalPackages`:** done (STUDY-148): installed by the deployment with `bun install` (DV-470–DV-473,
   decided by the owner, 2026-10-12).

**Low: rare, ops-only, or a missing nicety**

- Operations:
  - streaming import past `clear_tables` (built with its audit event, STUDY-141 PR 1): Airbyte records,
    Fivetran operations and primary-key indexes (PRs 2–4, future work by the owner's choice, 2026-10-11). The
    audit events bunvex does not record are not gaps: `build_indexes`, `change_deployment_state`,
    `change_system_stop_state` and `replace_environment_variable` are not emitted by Convex's open-source
    backend; `push_config` (legacy push) and `delete_component` (components) do not apply.
- The dashboard on a real deployment:
  - the largest single piece of work, but not something an app hits;
  - the server side of most screens exists (STUDY-149 lists the `_system/frontend` functions still to add);
  - the data source that calls it, `@bunvex/dashboard-source`, has its first parts (STUDY-149 PR 1: the
    deployment, schema, state, logs, function metrics and the `check_admin_key` sign-in; PR 2: the Data
    screen's reads, with the server's `getTableMapping`, `paginatedTableDocuments`, `indexes`, `listById`,
    `getById` and `/api/get_indexes`; PR 5: schedules, files, the audit log, Health's concurrency and
    invalidations); the rest is PRs 3, 4 and 6;
  - its data mutations (`_system/frontend` `addDocument`, `patchDocumentsFields`, `deleteDocuments`,
    `createTable`, …) bring the `add_documents`, `update_documents`, `delete_documents` and `create_table`
    audit events.
