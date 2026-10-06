# @bunvex/search

Full-text search for bunvex (STUDY-45): the tokenizer, the in-memory inverted index and BM25 ranking, with the
rules of Convex's search (tantivy's analyzer and scoring, Convex's term selection, matching and order). Pure:
it knows nothing of transactions; `@bunvex/core` keeps one index per search index and feeds it every commit.

It also holds the persisted segments of text and vector indexes (STUDY-111): `TextSegment` and `VectorSegment`,
immutable binary blobs read in place, and their rewritable deletes (`TextSegmentDeletes`, `VectorSegmentDeletes`).
