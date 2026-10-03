# Convex parity

bunvex is a rewrite of Convex for Bun: an app should work the same on both. This directory lists **everything
Convex has**, read from its source (get-convex/convex-backend @ `4577b9031`), and where bunvex stands on each
item. It is the project's to-do list at the scale of the whole product.

| Area | File | Done | Partial | Missing |
|---|---|--:|--:|--:|
| Function and database API: `ctx.db`, queries, validators, values, schema, limits | [server-api.md](server-api.md) | 148 | 26 | 59 |
| Clients, sync protocol, reactivity, React, HTTP client | [client-sync.md](client-sync.md) | 136 | 9 | 15 |
| Platform: auth, storage, scheduler, crons, search, HTTP actions, CLI, deploy, import/export, system tables | [platform.md](platform.md) | 124 | 47 | 75 |

These counts were taken on 2026-10-03 (main at #245) from each row's status column: a row counts as done,
partial or missing by the word its status starts with. A few rows have no single status and are not
counted.

## How to use it

- **Every PR that adds or changes a Convex feature updates the matching rows** in the same PR.
- A row goes from *missing* to *done* only with the study (`docs/study/`) and tests.
- Rows marked **Divergence?** in their notes are places where bunvex might deliberately differ. The owner
  decides them; until then, the default is to match Convex.
- **Every decided divergence gets a row in [divergences.md](divergences.md)**, the central ledger of what
  bunvex does differently from Convex and why. A PR that decides, changes or resolves one updates it.
- **Statuses:**
  - **done** means it matches Convex's behaviour.
  - **partial** means it exists but differs, and the note says how.
  - **missing** means it is not there.
- **Where Convex's code and docs disagree**, the code wins. Known cases are noted in the rows: indexes per
  table are 64 in the code and 32 in the docs; log lines are 32 KiB in the code and 4 KiB in the docs.

## Roadmap

The order follows one principle: **first make what exists correct, then make the core behave like Convex,
then grow outwards.** Each item becomes one or more PRs, each with its study.

### Phase 0 — correctness bugs in what already exists

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

### Phase 1 — the core behaves like Convex

1. **Values:** `@bunvex/values` with every `v.*` validator, `args`/`returns` checking, Int64/bigint,
   bytes, Convex's cross-type value order and the `$integer`/`$bytes`/`$float` JSON encoding.
2. **Index keys:** the implicit `_creationTime` before `_id` in every user index, `undefined`, and nested
   field paths.
3. **Documents:** field-name rules, system fields refused in writes, `replace`, `NonexistentDocument`, and
   the size, nesting, array and field-count limits.
4. **Queries:** `filter` and its builder, `unique`, `paginate` (cursors, `endCursor`, `maximumRowsRead`),
   async iteration, the transaction read/write limits, and a read-set narrowed to what `take` read (done
   in #134, DV-57).
5. **Transactions:** Convex's OCC retry budget and error (done in STUDY-21), the 1 s execution limit, and
   `db.vars.commitTs`.
6. **Function results:** `ConvexError` data, error redaction, status codes, `logLines` (done in STUDY-20,
   as `BunvexError`; cached query lines and subscription lines remain).
7. **Schema:** `defineSchema`/`defineTable`, document validation, `schemaValidation`, staged indexes, and
   tables created on first insert.

### Phase 2 — sync protocol and clients

Protocol v1:

- all queries advance together (Transition with state versions) — server side done (STUDY-23 step 2);
- read-your-writes (the mutation commit ts) — server side done (STUDY-23 step 2);
- mutation ordering per connection (done in STUDY-22);
- idempotency (session and request ids);
- reconnect and resend, auth messages.

Then `@bunvex/client` (base client, reconnect, backoff, optimistic updates, reactive pagination) and
`@bunvex/react` (`ConvexProvider`, `useQuery`, `useMutation`, `usePaginatedQuery`, auth helpers).

### Phase 3 — platform

In this order:

1. auth (OIDC and custom JWT, `ctx.auth`) — done;
2. scheduler and crons (STUDY-30) — done;
3. HTTP actions (STUDY-31) — done;
4. file storage (STUDY-32; it uses HTTP actions for uploads and downloads; built-in auth, STUDY-28, needs them
   too — swapped with HTTP actions by the owner, 2026-10-01) — done;
5. retention and garbage collection of old versions (STUDY-33) — done;
6. admin keys (STUDY-34);
7. pushing and deploying functions (STUDY-35): module loading, hot swap in `vm` contexts, the pushed code
   kept in the store, the deploy2 protocol, `bunvex deploy` — done;
8. codegen (`_generated/api`, `server`, `dataModel`; ARCH-01 open decision 1, decided: generate like Convex;
   STUDY-36);
9. the CLI, part 1: `start`, `deploy`, `dev`, `run`, `admin-key`, and environment variables (`process.env`,
   `env set|get|list|remove`);
10. the Docker image and docker-compose (credentials bootstrap), so a self-hosted app can be brought up as
    with Convex;
11. `ctx.runQuery` / `ctx.runMutation` inside queries and mutations, and the 1 s user execution limit
    (STUDY-41) — done, with N2, N3 and N6 built in #213;
12. the dashboard on a real deployment (its HTTP data source, with the UI session, and the `_system/*`
    functions it reads), then live logs;
13. built-in auth (STUDY-28) phases;
14. import/export in Convex's snapshot format, so data can move between Convex and bunvex (STUDY-42) —
    done; shape inference, cloud backups and the upgrade path remain (platform §18).

Items 7–12 were ordered by the owner on 2026-10-01 to reach a self-hosted example app end to end (bring the
containers up, deploy functions, see them work) before the remaining platform items.

### Phase 4 — the rest

- full-text search (STUDY-45: 6 done, 3 partial, 1 missing, platform §6) and vector search (STUDY-51: 5 done,
  1 partial, §7);
- components (1 of 7, §11);
- Node actions;
- log streaming (STUDY-47) and metrics (4 done, 1 partial, 7 missing, §20);
- streaming export;
- the dashboard's connection to a real deployment. Every screen is built on the mock (UI-01 §0, platform §21);
  it needs the server's admin API and admin-key login.
