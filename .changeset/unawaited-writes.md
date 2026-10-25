---
"@bunvex/core": patch
---

A mutation's writes it did not await are committed, as Convex's: the engine waits, after the handler, for the store calls still in flight and the code they resume. Before, an unawaited insert that created its table, or a write chained after an unawaited read, came after the commit and was lost while its promise answered an id. `TestRuntime` lets two quiet turns pass before a timer's work counts as settled.
