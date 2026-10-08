---
"@bunvex/core": patch
"@bunvex/server": patch
"@bunvex/values": minor
---

The system tables and their documents match Convex's (STUDY-133 PR 8, §12), so the two binaries open each other's stores:
- the summary checkpoint has an entry for every table;
- `_index_worker_metadata` keys an index by its internal id;
- a Convex zip package is read;
- the four system tables bunvex lacked are created empty;
- a push leaves the root component's rows;
- job and cron argument bytes are serde_json's text (`jsonText` in `@bunvex/values`);
- push audit rows carry `udfConfigDiff` and `_creationTime` in index fields;
- an empty table gets no schema validation attempt;
- an id's shape is a literal first.
