---
"@bunvex/helpers": minor
---

`@bunvex/helpers/server/triggers`: convex-helpers' triggers (`Triggers` with `register` and `wrapDB`,
`writerWithTriggers`, `Change`, `Trigger`, and the deprecated `DatabaseWriterWithTriggers`), with their locks and queue
kept per transaction instead of per module, so concurrent mutations do not wait on each other (DV-545, STUDY-181 PR 5).
