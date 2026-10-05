# STUDY-103 — Differential testing against Convex's own backend

- **Status:** decision pending (owner): D1, D2.
- **Convex source read:**
  - `main` of get-convex/convex-backend (`4577b9031`).
  - The last commits that still had tests: `bea52bde0` (Rust) and `c358201e1` (TypeScript), read locally,
    nothing copied.
- **Why now:** #410 found a bug no test had imagined. A query over a mutation's own writes handed out the
  written version, and mutating the result changed the stored document. TEST-01 §6 closes that class of bug.
  This study is the broader net: let Convex itself say what the right answer is, for inputs nobody wrote by
  hand.

## 1. How Convex checks its own behaviour

Convex tests the backend's semantics from four directions.

| Direction | Where (last open commits) | What it runs |
|---|---|---|
| **Function corpus** | `npm-packages/tests/udf-tests/convex/*.ts` (50 TypeScript modules: query, values, schema, size_errors, scheduler, search, …) and `crates/isolate/src/tests/*.rs` (39 files) | Rust tests run each function in a real isolate and assert results and error messages, for example `query:insert` then `query:filterScan` (`crates/isolate/src/tests/query.rs`). |
| **Client integration** | `npm-packages/tests/js-integration-tests/*.test.ts` (32 test files: basic, list, filter, scheduler, fileStorage, http, auth, …) | Jest drives `ConvexHttpClient` and `ConvexReactClient` against a real backend. A `cleanUp` mutation runs after each test, one worker at a time (its README). |
| **Property tests** | `crates/value/src/sorting.rs`, `crates/database/src/table_summary.rs`, `subscription.rs`, `table_iteration.rs`, `tests/randomized_search_tests.rs` | proptest over values, summaries, subscriptions and search. |
| **Simulation** | `npm-packages/tests/simulation` | A deterministic simulation of the sync client, driven from Rust (`src/*.ts` exposes `addQuery`, `queryResult`, …). |

bunvex already mirrors parts of each, and ports them case by case (STUDY-65, TEST-01 §3). What none of them
gives is **a comparison on inputs nobody chose**. Each test checks what its author thought of.

## 2. What an app observes

The contract is everything the HTTP API and the sync protocol show:
- function results and their encoding;
- errors (kind, message, data) and which calls fail;
- what the database holds afterwards (documents, ids per table, `_creationTime` order, index order);
- pagination (pages, cursors, `isDone`);
- what a query sees inside a mutation (its own writes, the snapshot);
- limits and the errors that enforce them.

The same operations on Convex and on bunvex must give the same observations, up to:
- the decided divergences (`docs/parity/divergences.md`);
- values that are random by design: ids, and the exact `_creationTime` (only its order is fixed).

## 3. bunvex: the design

### 3.1 The pieces

1. **The oracle.** Convex's local backend binary (`convex-local-backend`, as `convex-bench` runs it), on
   SQLite, in an empty directory. It is always started with `--disable-beacon`, as in `convex-bench`'s
   `backend.sh`: without it the binary sends a beacon to api.convex.dev.
2. **The app.** One module of functions, written from scratch for this harness. It takes operations as
   data: a mutation that applies a list of operations, a query that reads a range, a paginate, nested calls.
   - The schema has several tables, indexes of one and of several fields, a search index, optional fields
     and nested values.
   - It is deployed to Convex with Convex's CLI (`npx convex deploy`, self-hosted URL and admin key; tried:
     it works against the binary) and to bunvex with `bunvex deploy`.
3. **The generator.** fast-check, written from scratch, builds sequences of operations:
   - **writes:** `insert` / `patch` / `replace` / `delete`, with values of every kind, `undefined` fields,
     nesting and sizes near the limits;
   - **reads inside the same mutation:** of the transaction's own writes, the #410 shape;
   - **queries:** `withIndex` ranges (`eq`, `gt`, `lt`, …), `order`, `filter`, `take`, `first`, `unique`,
     and `paginate` with each cursor reused;
   - **nested calls:** `runQuery`, `runMutation`, and actions that call them;
   - **failures:** a thrown error, `ConvexError` data, a validator rejection, a mutation that fails after
     writing (nothing must stay), and limits.
4. **The runner.** It applies each sequence to both backends over the HTTP API (`/api/query`,
   `/api/mutation`, `/api/action`), records every answer, and at the end dumps every table in `_creationTime`
   order.
5. **The comparator.** It normalises both records, then compares them.
   - **Ids:** each id is mapped to `<table>#<n>` by first appearance, so equal histories compare equal, and
     an id of another table is still caught.
   - **`_creationTime`:** the order is checked, not the value.
   - **Errors:** the class (function error, request error, system error) and the data are compared. The
     message is compared after the rewrites the decided divergences allow, for example DV-03 / DV-04 / DV-312
     (bunvex words where Convex's mention Convex), in a table the comparator reads.
   - **Everything else:** compared exactly.
6. **Shrinking.** fast-check shrinks a failing sequence to a minimal one. The runner writes it as a
   reproducible case (`seed`, the operations as JSON) and as a ready-made regression test for `core` or
   `server`.

### 3.2 Phases (one PR each)

1. The harness: start and stop the oracle and bunvex, deploy the app, run one fixed sequence, compare.
2. The generator and the comparator for writes and reads inside one mutation (the #410 class), then
   queries and pagination.
3. Nested calls, actions, errors and limits.
4. The nightly job (D2), and the triage loop: every difference is filed as a bug (fixed with a regression
   test) or matched to a decided divergence (one comparator rule, with its DV id).

### 3.3 What it will not cover at first

- Concurrency and OCC: the comparison is of sequential histories. Jepsen (STUDY-57) covers concurrency.
- Sync-protocol timing.
- Components, which bunvex does not have yet.
- Node actions.

## 4. Divergences and decisions

| # | Question | Options | Recommendation |
|---|---|---|---|
| **D1** | Convex's own `js-integration-tests` (FSL, from the snapshot) as a second oracle, run against bunvex? | **A.** Run them only on the owner's machine, from the local snapshot, never vendored into the repo (nothing copied, as CLAUDE.md requires). **B.** Do not use them; only the generator of §3. | **A**, as a manual pass before each release: 32 test files of what a real Convex app relies on, free to run. Their failures become bunvex tests written from scratch. |
| **D2** | Where the generator runs | **A.** A nightly CI job that downloads Convex's released backend binary (as `convex-bench`'s `download-backend.sh` does) and runs about 20 minutes of sequences. **B.** Only on demand, locally. | **A**: a difference found the next morning is cheap. The binary is downloaded at run time, never stored in the repo. |

No behaviour of bunvex changes in this study: it adds tests only.
