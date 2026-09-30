# Convex parity

bunvex is a rewrite of Convex for Bun: an app should work the same on both. This directory lists **everything
Convex has**, read from its source (get-convex/convex-backend @ `4577b9031`), and where bunvex stands on each
item. It is the project's to-do list at the scale of the whole product.

| Area | File | Done | Partial | Missing |
|---|---|--:|--:|--:|
| Function and database API: `ctx.db`, queries, validators, values, schema, limits | [server-api.md](server-api.md) | 25 | 36 | ~170 |
| Clients, sync protocol, reactivity, React, HTTP client | [client-sync.md](client-sync.md) | 4 | 22 | ~132 |
| Platform: auth, storage, scheduler, crons, search, HTTP actions, CLI, deploy, import/export, system tables | [platform.md](platform.md) | 2 | 16 | ~213 |

These counts were taken on 2026-09-29, with #6 (catalog) and #7 (ids) counted as done. A few rows have
no single status.

## How to use it

- **Every PR that adds or changes a Convex feature updates the matching rows** in the same PR.
- A row goes from *missing* to *done* only with the study (`docs/study/`) and tests.
- Rows marked **Divergence?** in their notes are places where bunvex might deliberately differ. The owner
  decides them; until then, the default is to match Convex.
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
| B4 | Long index keys fail the flush: MySQL `varbinary(512)`, Postgres btree ~2.7 KB. Convex splits keys into prefix + sha256 | STUDY-09 D3 |
| B5 | **Fixed in #10** (with the implicit `_creationTime` and sub-ms creation times). `withIndex` ignores field names: wrong or out-of-order fields silently return every row | STUDY-05 D2/D5, STUDY-07 D3 |
| B6 | **Fixed in #21.** Missing fields are indexed as `null`, where Convex indexes them as `undefined`; `eq(f, undefined)` throws | STUDY-05 D4 |
| B7 | **Fixed in #21.** NaN, ±Infinity, −0, `undefined` in arrays and `Date` are changed by `JSON.stringify`, so the stored document and its index keys disagree | STUDY-10 D1 |
| B8 | **Fixed in #11.** Subscriptions can get stuck after an error: no re-send when the value returns to its pre-error value; never re-run if the first run throws | STUDY-08 D1/D2 |
| B9 | **Fixed in #13.** Values are not copied at the call: mutating an object after `insert`, or a `get` result, changes what is stored | STUDY-10 D3 |
| B10 | **Fixed in #13.** The query cache hands out results by reference: a caller mutating a result corrupts it for others | STUDY-08 D3 |
| B11 | **Fixed in #21.** Objects, arrays and bytes are not encodable in index keys (all objects encode equal) | STUDY-05 D6 |
| B12 | **Fixed in #12** (with Convex's transaction read limits). `collect()` is silently capped at 8192 rows; `take(0)` or a negative `take` misbehaves on the memory driver | STUDY-07 D1/D2 |
| B13 | Once `ctx.auth` exists, cache and subscription keys would serve one user's results to another (latent) | STUDY-08 D6 |
| B14 | **Fixed in #11.** One socket subscribing twice to the same key leaks a reference count | client-sync.md |

### Phase 1 — the core behaves like Convex

1. **Values:** `@bunvex/values` with every `v.*` validator, `args`/`returns` checking, Int64/bigint,
   bytes, Convex's cross-type value order and the `$integer`/`$bytes`/`$float` JSON encoding.
2. **Index keys:** the implicit `_creationTime` before `_id` in every user index, `undefined`, and nested
   field paths.
3. **Documents:** field-name rules, system fields refused in writes, `replace`, `NonexistentDocument`, and
   the size, nesting, array and field-count limits.
4. **Queries:** `filter` and its builder, `unique`, `paginate` (cursors, `endCursor`, `maximumRowsRead`),
   async iteration, the transaction read/write limits, and a read-set narrowed to what `take` read.
5. **Transactions:** Convex's OCC retry budget and error, the 1 s execution limit, and `db.vars.commitTs`.
6. **Function results:** `ConvexError` data, error redaction, status codes, `logLines`.
7. **Schema:** `defineSchema`/`defineTable`, document validation, `schemaValidation`, staged indexes, and
   tables created on first insert.

### Phase 2 — sync protocol and clients

Protocol v1:

- all queries advance together (Transition with state versions);
- read-your-writes (the mutation commit ts);
- mutation ordering per connection;
- idempotency (session and request ids);
- reconnect and resend, auth messages.

Then `@bunvex/client` (base client, reconnect, backoff, optimistic updates, reactive pagination) and
`@bunvex/react` (`ConvexProvider`, `useQuery`, `useMutation`, `usePaginatedQuery`, auth helpers).

### Phase 3 — platform

In this order:

1. auth (OIDC and custom JWT, `ctx.auth`);
2. scheduler and crons;
3. file storage;
4. HTTP actions;
5. retention and garbage collection of old versions;
6. admin keys;
7. the CLI and codegen;
8. import/export in Convex's snapshot format, so data can move between Convex and bunvex.

### Phase 4 — the rest

- full-text and vector search;
- components;
- Node actions;
- log streaming and metrics;
- streaming export;
- the dashboard. The UI session is building it; see #2.
