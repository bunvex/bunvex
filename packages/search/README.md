# @bunvex/search

Full-text search for bunvex: the tokenizer, the in-memory inverted index and BM25 ranking (tantivy's analyzer and
scoring), and the rules for which terms a search uses, what matches and in what order. Pure:
it knows nothing of transactions; `@bunvex/core` keeps one index per search index and feeds it every commit.

It also holds the persisted segments of text and vector indexes: `TextSegment` and `VectorSegment`,
immutable binary blobs read in place, and their rewritable deletes (`TextSegmentDeletes`, `VectorSegmentDeletes`).
