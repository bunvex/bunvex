---
"@bunvex/core": patch
---

`paginate()` at a transaction read limit returns the page so far with `pageStatus: "SplitRequired"` instead of throwing, as Convex's; before any document, a first page fails with Convex's system error. The limit errors an app sees are unchanged (a plain `Error`, no code). Also as Convex: a pinned page ignores `maximumRowsRead`/`maximumBytesRead`, `splitCursor` is set on any page that read more than two documents, and `SplitRecommended` uses the transaction's limits when the page sets none.
