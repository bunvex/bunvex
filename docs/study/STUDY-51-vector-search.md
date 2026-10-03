# STUDY-51 — Vector search

- **Status:** V1–V2 decided by the owner (2026-10-02: exact, in memory); V3–V5 decision pending (owner)
- **Convex source read:** `main` of get-convex/convex-backend, 2026-10-03
- **Related:** [STUDY-45](STUDY-45-text-search.md) (the search index structure this reuses), [STUDY-29](STUDY-29-index-backfill.md)

## 1. How Convex does it

### 1.1 Schema

- `vectorIndex(name, {vectorField, dimensions, filterFields?, staged?})` (`server/schema.ts`) is not checked on the client. It is pushed as `vectorIndexes` / `stagedVectorIndexes`: `{indexDescriptor, vectorField, dimensions, filterFields}`.
- Backend checks (`schemas/json.rs`, `vector_index/dimensions.rs`, `schemas/mod.rs`):
  - dimensions from 2 to 4096: "Dimensions {d} must be between 2 and 4096.";
  - at most 16 filter fields: "Search indexes may have up to 16 filter fields." (sic);
  - filter fields deduplicated;
  - at most 64 indexes per table;
  - no two vector indexes on the same (field, dimensions): "… have the same \`vectorField\` …";
  - names unique across every index kind, and the reserved names;
  - the vector field must be able to hold `array(float64)` under the document schema.

### 1.2 Search (`ctx.vectorSearch`, actions only)

- **JS side** (`vector_search_impl.ts`):
  - the argument checks;
  - "\`vector\` must be a non-empty Array in vectorSearch";
  - the filter builder `q.eq(field, value)` / `q.or(...)`, which only takes a field name first.
- **Backend** (`crates/vector`):
  - **Similarity**: cosine, as a dot product of L2-normalized f32 vectors (qdrant). A zero vector is left as is.
  - **`_score`**: an f32, widened to f64.
  - **Limit**: 10 by default, at most 256.
  - **Filter**: flattened to field → values; fields are ORed. At most 64 conditions, and only the index's filter fields.
  - **Ordering**: equal scores order by internal id bytes, descending.
- **Errors**, checked in this order:
  1. dimensions above 4096;
  2. a limit above 256;
  3. a filter field not indexed;
  4. too many conditions;
  5. dimension mismatch.
  - Index errors: not found, staged, backfilling, "is not a vector index".
  - A missing table gives `[]`.
- **Indexing**: a document whose field is not an array of `dimensions` float64s is silently left out.
- **Consistency**: searches run against the latest committed state. They are not reactive and not transactional.
- **Index structure**: an exact in-memory index over recent writes, plus HNSW disk segments, which are approximate.

## 2. What an app can observe

Results and scores, their order, the errors above, which documents are indexed, and that a search sees the
mutations already awaited.

## 3. How bunvex does it

- **Schema**: `vectorIndex` with the checks above, typed in the data model, and Convex's JSON form.
- **Engine** (`core/src/vector-indexes.ts`): per index, a map from id to normalized f32 vector and filter keys.
  - It is backfilled at one snapshot and updated by each commit as it becomes visible, as the text search indexes are.
  - Searches are exact: every vector is compared, with f32 arithmetic.
- **`ctx.vectorSearch`** on actions and HTTP actions, with Convex's argument checks and filter builder.
- **Measured**: 10 000 vectors of 1536 dimensions are searched in about 17 ms.

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| V1 | Exact search over every document | Convex's disk segments are approximate (HNSW); bunvex is at least as accurate | DV-269, owner 2026-10-02 |
| V2 | Indexes live in memory only and are rebuilt at start | The owner's choice: no persisted segments. Memory grows with the vectors | DV-270, owner 2026-10-02 |
| V3 | While an index is being built after a start, a search fails at once with `IndexBackfillingError` | Convex retries `VectorIndexesUnavailable` up to 5 times during bootstrap. **Not done yet** | DV-271, accepted (owner, 2026-10-03) |
| V4 | The vector field is not checked against the document schema at push | **Not done yet** | DV-272, accepted (owner, 2026-10-03) |
| V5 | A negative or non-integer `limit` gives bunvex's message, not serde's | Rust's deserializer message. **Not possible** to reproduce exactly | DV-273, accepted (owner, 2026-10-03) |
