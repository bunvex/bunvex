# STUDY-181 — `@bunvex/helpers`, part 1: custom functions, streams and pagination, triggers, validators

- **Status:** decided (owner, 2026-10-20): H-1–H-8 as recommended (§7); DV-545 decided. To build in §3.4's
  order, with H-5 (`TableDefinition.indexes` in Convex's runtime shape) first, as a platform PR.
- **Convex source read:** get-convex/convex-helpers at `e48f9df` (0.1.128), pinned in
  [upstream.md](../parity/upstream.md#other-repositories). Paths are relative to `packages/convex-helpers/`.
- **bunvex source:** `main` and the STUDY-180 branch (`fix/api-exports-parity`, the public names). Paths are
  relative to `packages/`.
- **Scope:** part 1 of the port of convex-helpers ([STUDY-158](STUDY-158-own-components.md) §3.4 step 3). This part
  covers what Convex's components and most apps use:
  - `index.ts`, the small utilities;
  - `validators.ts`;
  - `server/customFunctions.ts`;
  - `server/stream.ts` and `server/pagination.ts`;
  - `server/triggers.ts`;
  - `server/compare.ts`.

  It builds AD-23 (`typedV` and `doc`, accepted "with a port of convex-helpers").
- **Related:**
  - [STUDY-158](STUDY-158-own-components.md) G3 and G4, paging and helpers inside the components;
  - [STUDY-159](STUDY-159-testing.md), `@bunvex/testing`, which runs the oracles;
  - [STUDY-180](STUDY-180-public-api-names.md), the public names these modules import;
  - AD-23 ([STUDY-100](STUDY-100-typed-validators.md) T3);
  - DV-492, module state.

## 1. How Convex does it

Sizes are without tests.

| Module | Lines (code) | What it is |
|---|---|---|
| `index.ts` | 179 (70) | `asyncMap`, `pruneNull`, `nullThrows` / `NullDocumentError`, `pick`, `omit`, `withoutSystemFields`, `assert`, and type helpers |
| `validators.ts` | 1055 (746) | See below |
| `server/customFunctions.ts` | 669 (354) | `customQuery`, `customMutation`, `customAction`, `customCtx`, `customCtxAndArgs`, `NoOp`, and the `Customization`, `CustomBuilder`, `CustomCtx` types |
| `server/stream.ts` | 2075 (1724) | A query engine over `ctx.db` (see below) |
| `server/pagination.ts` | 225 (125) | `getPage`, `streamQuery`, `paginator` (`stream` under another name) |
| `server/triggers.ts` | 520 (434) | `Triggers` (`register`, `wrapDB`), `writerWithTriggers`, `Change` |
| `server/compare.ts` | 4 | Re-exports `compareValues` (deprecated) |

`validators.ts` holds:
- `literals`, `nullable`, `partial`;
- `systemFields`, `withSystemFields`, `addFieldsToValidator`;
- `doc`, `typedV`, `brandedString`, `deprecated`, `pretend`, `pretendRequired`;
- `ValidationError`, `validate`, `parse`, `vRequired`.

`stream.ts` is a query engine over `ctx.db`. It provides:
- index-range reflection;
- `streamIndexRange`, which splits an arbitrary key interval into ranges Convex can express;
- `mergedStream`, `filterWith`, `map`, `flatMap`, `distinct` (a loose index scan);
- `paginate`, with Convex's `pageStatus` / `splitCursor`, `maximumRowsRead` and `maximumBytesRead`.

### 1.1 What shapes a rewrite

- **customFunctions.**
  - The builder gets the merged args (`addFieldsToValidator(args, inputArgs)`), and the engine validates them all.
  - `input(ctx, picked args, extra)` returns `{ctx, args, onSuccess?}`. The handler sees `{...ctx, ...added.ctx}` and its own args with the added ones.
  - `onSuccess({ctx, args, result})` runs only after a handler that did not throw.
  - Keys other than `args`, `returns` and `handler` go to `input` only.
  - A function with no `args` whose customization declares args throws "If you're using a custom function with arguments for the input customization, you must declare the arguments for the function too."
- **stream and pagination.**
  - **Cursors.** A cursor is the JSON of the index key in Convex's value JSON (`$integer`, `$float`, `$bytes`).
    - `undefined` is written as `"undefined"`, and a string that ends in `"undefined"` gets `"_"` prepended.
    - The end cursor is `"[]"`.
    - Cursors are not encrypted. They carry the keys of filtered-out rows too.
  - **Index fields.** `by_creation_time` is `[_creationTime, _id]` and `by_id` is `[_id]`. A named index is its fields plus `_creationTime` and `_id`.
    - They are read from `schema.tables[t].indexes`, **Convex's private array of `{indexDescriptor, fields}`** (`stream.ts:178`).
  - **Ranges.** It queries `q.eq("_creationTime", t).gt("_id", id)`-shaped ranges, and opens several queries at once (`mergedStream`).
  - **Page status.**
    - `SplitRequired` when a row or byte limit is hit.
    - `SplitRecommended` past 16,000 scanned keys or `numItems + 1` rows.
    - The default page is 100 rows.
  - **Paginating with `numItems` 0.**
    - With a null cursor it throws ".paginate called with cursor of null and 0 for numItems. …".
    - Otherwise it returns an empty page at the same cursor.
- **triggers.**
  - Only `insert`, `patch`, `replace` and `delete` of tables with triggers are wrapped.
  - Each wrapped write reads the old and new documents, then queues the table's triggers in registration order.
  - The outermost write drains the queue FIFO, so recursion is breadth-first.
  - The first trigger error is rethrown after the drain, and later ones are logged. The mutation's transaction gives atomicity.
  - **The two locks and the queue are module-level** (`triggers.ts:149-151`).
- **validators.**
  - `nullable(x)` is `union(null, x)`: null first, unlike `v.nullable`.
  - `partial` branches on `isConvexValidator`.
  - `validate` and `parse` check values in JS, with error paths, and are `__proto__`-safe.
  - `vRequired` throws "Unknown Convex validator type: " for an unknown kind.

### 1.2 Their tests (the oracles)

| Test file | Lines | What it covers |
|---|---|---|
| `customFunctions.test.ts` | 799 | Auth, args added, consumed or redefined, nesting, `extra`, `onSuccess` |
| `stream.test.ts` | 1836 | Ranges, merges, flatMap and resume, distinct, `endCursor`, split statuses, `undefined` in cursors, bandwidth |
| `stream.flatmap.test.ts` | 220 | flatMap |
| `stream.property.test.ts` | 1386 | Property tests over mixed-type keys (null, bool, int64, number, string, bytes, array, object, missing): cursors stay scoped, completeness, static bounds against an oracle, narrowing |
| `pagination.test.ts` | — | Manual pages and `paginator` |
| `triggers.test.ts` | — | Denormalizing, implicit and explicit ids, create, update and delete |
| `validators.test.ts` and `server/validators.test.ts` | — | Every validator and `validate` / `parse` case |

They run on convex-test, which is `@bunvex/testing` here (STUDY-159).

## 2. What an app can observe

- **The API.** Every export, the subpaths (`convex-helpers/server/customFunctions`, …) and the types.
- **The cursors.** Apps and components store them: migrations and workpool keep convex-helpers cursors in their tables (STUDY-158 §1.3).
- **The page shapes and statuses.**
- **Trigger order and error handling.**
- **The error messages.**
- **`nullable`'s member order.** It shows in a validator's JSON and in union matching.

## 3. How bunvex does it

### 3.1 What already works

These come from `@bunvex/values` and `@bunvex/server` (with STUDY-180):
- `compareValues`, with Convex's mixed-type ranks;
- `getDocumentSize` and `toJsonValue` / `fromJsonValue` with Convex's encoding;
- `asObjectValidator`, `v.commitTs`, and every `V*` class;
- every `convex/server` type these modules name;
- `withIndex` with every operator and a trailing `_id` (`core/src/tx.ts:139-210`), and `undefined` keys;
- `order`, async iteration, `db.system`, `db.vars`, and the two-argument `get` / `patch` / `replace` / `delete`;
- a `VObject` as `args`, and `PaginationResult` with `pageStatus` / `splitCursor`.

### 3.2 Gaps and differences

- **`TableDefinition.indexes`.** bunvex has `Record<string, string[]>` (`core/src/schema.ts:136`). Convex has an array of `{indexDescriptor, fields}`, which is private in its types but is what convex-helpers reads. See H-5.
- **The `isConvexValidator` property.** bunvex's is `isValidator`. The port reads that, which rule 5 requires anyway.
- **Triggers' module-level locks and queue.**
  - Convex evaluates a request's modules afresh, so the locks belong to one request. bunvex evaluates them once per code version (DV-492), so they would be shared by every concurrent mutation:
    - writes to trigger tables would be serialized across requests;
    - one mutation that never settles would block the others.
  - The port keys them per transaction, which is what an app observes on Convex. See H-4.
- **`ctx` spreads.** `customCtx` and `wrapDB` spread `ctx`, which reads bunvex's lazy `rooms` getter (AD-42) each time. That is extra work, not a different result. The port keeps it lazy.
- **Rule 5.** The changes:
  - `convexToJson` / `jsonToConvex` become `toJsonValue` / `fromJsonValue`;
  - `isConvexValidator` becomes `isValidator`;
  - "Unknown Convex validator type: " becomes "Unknown validator type: " (DV-544).

### 3.3 The package

- **Location:** `packages/helpers`, `@bunvex/helpers` (STUDY-158 Q-1: in the monorepo, versioned on its own outside changesets' fixed group).
- **Subpaths:** they mirror convex-helpers': `.`, `./validators`, `./server/customFunctions`, `./server/stream`, `./server/pagination`, `./server/triggers`, `./server/compare`. Later parts add the rest. An app moves by renaming `convex-helpers` to `@bunvex/helpers` in its imports.
- **Dependencies:** `@bunvex/server` and `@bunvex/values`, as peer dependencies. It is bundled into a push like any package, since STUDY-158 G1 (#772).
- **Code:** written from scratch against this study and the oracles, never copied.

### 3.4 Order (PRs)

1. **The package, `index.ts`, `validators.ts`, `server/compare.ts`.** These are pure and tested as units.
2. **`server/customFunctions.ts`.** Its tests run on `@bunvex/testing`.
3. **`server/stream.ts`, with the property tests.** It is the largest and riskiest piece.
4. **`server/pagination.ts`.** This unblocks the components (STUDY-158 G3).
5. **`server/triggers.ts`**, with the per-transaction locks (H-4).

Every PR ports its module's tests as bunvex tests: the same scenarios, written for bunvex. Where it is cheap, a differential check runs the same calls on Convex's binary with convex-helpers 0.1.128. The cursors are compared byte for byte (H-2).

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| DV-544 | Rule 5 in `@bunvex/helpers`: "Unknown validator type: " for convex-helpers' "Unknown Convex validator type: "; `isValidator` for `isConvexValidator` | Rule 5 | rule 5 (no owner choice) |
| DV-545 | Triggers' locks and queue per transaction, not per module | bunvex evaluates modules once per code version (DV-492); per module, concurrent mutations would share them | owner, 2026-10-20 (H-4) |

## 4b. Additions (beyond Convex)

None new. AD-23 (`typedV`, `doc`) is accepted and built here.

## 5. Tests

- Each module's convex-helpers tests, ported as bunvex tests on `@bunvex/testing`, including the property tests of `stream.ts` with the same seeds.
- A differential check for stream cursors and pages: the same data and calls through convex-helpers on Convex's binary and through `@bunvex/helpers` on bunvex, compared byte for byte.
- A sabotage check per PR.

## 6. Not verified yet

- Several queries open at once in one transaction (`mergedStream`). bunvex should allow it; the property tests will show it.
- Whether a trigger that calls `ctx.runMutation` while the outer write holds the lock deadlocks under per-module locks. That is moot under H-4's per-transaction locks.

## 7. Questions for the owner

All decided by the owner on 2026-10-20, as recommended.

| # | Question | Recommendation |
|---|---|---|
| H-1 | The name and subpaths: `@bunvex/helpers`, mirroring convex-helpers' subpaths, versioned on its own | **Yes.** An app moves by renaming the import |
| H-2 | The cursor format: byte-exact with convex-helpers', meaning the value JSON, the `"undefined"` / `_` escape, and `"[]"` | **Byte-exact.** Components store these cursors, and a Convex store or export carries them |
| H-3 | The deprecated APIs (`Mod`, `DatabaseWriterWithTriggers`, `compare.ts`, `nullable`, `partial`, `withSystemFields`, `doc`, `typedV`) | **Keep them.** They are small and still in use, and they are convex-helpers' current API, not paths for older stores (unlike STUDY-158's DV-539). `typedV` and `doc` are in AD-23 |
| H-4 | Triggers' locks: per transaction (DV-545), or per module as upstream | **Per transaction.** It is what an app observes on Convex |
| H-5 | `TableDefinition.indexes`: give it Convex's runtime shape (an array of `{indexDescriptor, fields}`), or have the port read bunvex's own field | **Convex's shape.** It is a gap fix: other libraries read it too. bunvex's own uses move to an internal name |
| H-6 | `nullable`'s order: null first, as upstream | **As upstream.** It is what the validator JSON shows |
| H-7 | `PageRequest.indexFields`: declared upstream, never read | **As upstream:** accepted and ignored |
| H-8 | The order of §3.4 | **Yes.** `@bunvex/testing` (STUDY-159) is built first, so the oracles run from PR 2 |
