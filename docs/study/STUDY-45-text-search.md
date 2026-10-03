# STUDY-45 — Full-text search (`searchIndex`, `withSearchIndex`)

- **Status:** accepted: S1–S6 as recommended (owner, 2026-10-02)
- **Convex source read:** commit `4577b9031` of get-convex/convex-backend. Convex runs a fork of tantivy
  (`get-convex/tantivy` rev `2bb95afa`) that is not in that checkout: the tokenizer's and BM25's details marked
  *(tantivy)* come from upstream tantivy.
- **Related:** roadmap Phase 4; [STUDY-29](STUDY-29-index-backfill.md) (index states, staged indexes),
  [STUDY-08](STUDY-08-cache-and-subscriptions.md) (read sets and invalidation), [STUDY-06](STUDY-06-transactions-and-occ.md).

## 1. How Convex does it

### 1.1 Schema
- `defineTable(…).searchIndex(name, { searchField, filterFields?, staged? })` (`npm/convex/src/server/schema.ts:445-469`):
  no checks in TS; the schema JSON carries `searchIndexes` / `stagedSearchIndexes`, each
  `{ indexDescriptor, searchField, filterFields }` (`crates/common/src/schemas/json.rs:113-125, 498-504`).
- Checked by the server (messages in `index_validation_error.rs`):
  - up to **16 filter fields** (`IndexTooManyFilterFields`: "Search indexes may have up to 16 filter fields.");
    duplicates silently merged (a set);
  - field paths of identifiers joined by `.` (`InvalidIndexField`); with schema validation, the fields must
    exist in the document schema (`SchemaDefinitionError`);
  - two search indexes with the same `(searchField, filterFields)` are refused (`SearchIndexFieldNotUnique`);
  - index names unique across database, search and vector indexes (`IndexNamesNotUnique`), the usual name
    rules, 64 indexes per table in all;
  - no type check on `searchField`: a document whose field is not a string is simply not indexed.

### 1.2 Queries
- `db.query(t).withSearchIndex(name, q => q.search(field, text).eq(f, v)…)`
  (`impl/search_filter_builder_impl.ts`, `impl/query_impl.ts`): sent as the source
  `{type: "Search", indexName, filters: [{type: "Search", fieldPath, value}, {type: "Eq", fieldPath, value}]}`.
- Then `filter`, `take`, `first`, `unique`, `collect`, `paginate`, iteration; `.order()` throws "Search
  queries must always be in relevance order. Can not set order manually."
- Server checks (`crates/search/src/lib.rs:755-873`): the search field must be the index's
  (`IncorrectSearchField`), one search filter only (`DuplicateSearchFiltersError`), `eq` only on filter fields
  (`IncorrectFilterFieldError`), a search filter required (`MissingSearchFilterError`), **at most 8 `eq`s**
  (`TooManyFilterConditionsInSearchQueryError`); `withSearchIndex` on a database index and the reverse are
  refused; a backfilling or staged index gives the usual `IndexBackfillingError` / `IndexStagedError`.

### 1.3 Tokens
- One analyzer for documents, queries and read sets (`search/src/constants.rs:44-48`): split on every character
  that is not alphanumeric (Unicode) *(tantivy)*, **drop** tokens of 32 bytes or more *(tantivy: `len < 32`)*,
  lowercase. No stemming, no accent folding, no stop words.

### 1.4 Matching and ranking
- An empty query, or one with no tokens, returns nothing. **At most 16 query terms**: the rest are ignored.
- The **last term also matches as a prefix** (clients ≥ 1.6.1000), with BM25 weight × 0.5 for prefix
  expansions; at most 64 unique terms in all. **No fuzzy matching** (the code is there, the distance is 0).
- A document matches when it has **at least one** query term (OR) and **every** `eq` (AND). `eq` compares the
  value's sort key (so int64 ≠ float64, and `eq(f, undefined)` matches a missing field).
- Score: **BM25** over the matched terms (tantivy defaults k1 = 1.2, b = 0.75 *(tantivy)*), with the corpus
  statistics of the whole index, the transaction's own writes included. Order: score desc, then
  `_creationTime` desc, then id. `_score` is not returned.
- **At most 1024 candidates**: reading past them throws "Search query scanned too many documents (fetched
  1024). Consider using a smaller limit, paginating the query, or using a filter field to limit the number of
  documents pulled from the search index." Pagination re-runs the search per page and keeps what is after the
  cursor (`(-score, -creationTime, id)`); approximate, never past the top 1024.

### 1.5 Transactions and reactivity
- A search records **its terms and its filters** in the read set (`search/src/query.rs:572-668`), plus by-id
  reads of the documents returned.
- **OCC**: a write conflicts when its document (old or new) matches *all* the filters and *one* term
  (prefix terms by every prefix of the document's tokens).
- **Subscriptions** are more cautious: invalidated when *any* filter or *any* term matches.
- A transaction's searches see its own pending writes, statistics included.

### 1.6 Storage and limits
- In Convex an index is disk segments (tantivy) plus a memory index of recent writes, flushed at 10 MiB and
  compacted; writes are refused (`TextIndexTooLarge`) when the memory part reaches 100 MiB. States: backfilling
  → backfilled → snapshotted; staged indexes as database ones.

## 2. What an app can observe

The schema API and its errors; which documents match, in which order, the 1024 limit and pagination; that
search results are transactional (own writes) and reactive (subscriptions re-run on matching writes); the
errors of a misused query; the index states while a search index is built.

## 3. How bunvex does it (proposal)

- **PR 1 — the schema:** `searchIndex` in `defineTable` (and staged), Convex's checks and messages, the schema
  JSON, `_index` rows of kind `search`, the data model's types, codegen.
- **PR 2 — the index and the query:** a tokenizer as §1.3; per search index an **in-memory inverted index**
  (term → postings, document lengths, corpus statistics), built by a backfill at start and on push (the index
  backfilling meanwhile), kept up to date on every commit; `withSearchIndex` with Convex's checks, matching,
  BM25, ordering, the 1024 limit and pagination; a transaction's own writes overlaid.
- **PR 3 — reactivity:** the terms and filters in the read set; Convex's OCC rule at commit and its
  subscription rule for invalidation.

### As built

- **PR 1** (#225): the schema.
- **PR 2** (#PR2): `@bunvex/search`, a package of its own (owner, 2026-10-02):
  - `tokenize`;
  - tantivy's fieldnorm code, its table generated from tantivy's documented formula and checked equal entry by entry;
  - BM25 in 32-bit floats;
  - `TextIndex`: term selection, matching, ranking, 1024 candidates, an overlay.
- **In core** (`core/src/search-indexes.ts`):
  - one index per search index of an active table, backfilled at one snapshot. Commits that land meanwhile are applied, and the backfill's older copies are not written over them;
  - each index is updated in commit order from the commit's `onVisible`;
  - a 5-minute log of changes lets a transaction search an older snapshot;
  - `Tx.withSearchIndex` with Convex's checks, ordering, limits and pagination. The cursor's id part is complemented, so ties page in the results' order.
- **PR 3:** the read set (terms and filters), conflicts and invalidation.

## 4. Divergences (decisions)

| # | Divergence | Why | Decision |
|---|---|---|---|
| S1 | The index lives **in memory only**, rebuilt from the table at every start (queries meanwhile get `IndexBackfillingError`), where Convex keeps disk segments | bunvex has no segment store; a persisted index is a later step. Observable: memory, and searches unavailable while a big table is indexed at start | accepted: in memory now; persisted segments later, "Waiting on a dependency": none (owner, 2026-10-02), DV-227 |
| S2 | No 100 MiB backpressure (`TextIndexTooLarge`) | there is no unflushed memory part to bound in S1's design | accepted: accept with S1 (owner, 2026-10-02), DV-228 |
| S3 | BM25 computed by bunvex: the same formula and parameters, but tantivy stores document lengths in one lossy byte (its fieldnorm code), which we could reproduce or not | exact scores — and so the order of near-ties — differ unless the encoding is copied | accepted: reproduce tantivy's fieldnorm encoding, so the order matches (owner, 2026-10-02) |
| S4 | The tokenizer follows upstream tantivy's `SimpleTokenizer` (`char::is_alphanumeric`) and `RemoveLongFilter` (< 32 bytes) | Convex's fork is not public in the checkout; if it differs, so do we | accepted: accept; verify against a Convex deployment when one is at hand (owner, 2026-10-02), DV-229 |
| S5 | Merged reads of several searches on one index in one transaction: Convex ANDs all their filters, which seems to make conflicts on filters impossible (an apparent bug; inferred, not tested) | — | accepted: match Convex's documented intent — each search's own filters — and record it (owner, 2026-10-02), DV-230 |
| S6 | The client version gate for prefix matching (≥ 1.6.1000) | bunvex's client announces 0.0.0 (DV-225) | accepted: always prefix-match the last term, as every current Convex client gets (owner, 2026-10-02), DV-231 |

## 5. Tests

The schema checks and messages; tokenization (punctuation, Unicode, long tokens); OR/AND matching, prefix,
`eq` on null/undefined/int64/float64; BM25 order against hand-computed scores and ties by `_creationTime`;
the 16-term and 1024 limits; pagination; own writes; OCC (a conflicting and a non-conflicting write) and a
subscription re-run; backfill at start and push; staged indexes.
