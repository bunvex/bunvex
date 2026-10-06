---
"@bunvex/core": minor
"@bunvex/server": patch
---

Every search and vector index has its `_index` row, as Convex's: `config` in Convex's serialized shape (`type`, the spec's fields, `onDiskState` `backfilling` / `backfilling2` / `snapshotted` with the segment list), staged indexes included (STUDY-111). The segments' state lives there instead of a persistence global. The clean-shutdown snapshot (STUDY-96) is removed; the engine's `searchSnapshots` option is now `searchStorage`.
