---
"@bunvex/persistence": minor
"@bunvex/values": minor
"@bunvex/core": minor
---

MySQL documents are stored and read as their JSON text only. Convex's v1 encoding (an LZ4 block over the sort key)
is no longer read or written, and the `MYSQL_DOCUMENT_ENCODING` knob and `documentEncoding` option are gone: a
v1 document is refused with a message that says to export the data and import it. `sortKeyToJsonText`, which
only v1 used, is removed from `@bunvex/values` and `@bunvex/core/persistence` (STUDY-139 P5, DV-443).
