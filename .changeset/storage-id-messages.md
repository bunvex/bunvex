---
"@bunvex/server": patch
---

`ctx.storage.getUrl`, `getMetadata`, `delete` and an action's `get` refuse another table's id with Convex's
message alone ("Invalid storage ID. Storage ID cannot be an ID on any table other than '_storage'."), no longer
wrapped as an argument error. An id that does not parse keeps the wrapper, and its text is now Convex's to the
character, including the line break and indentation in Convex's source string (checked against Convex's binary). A legacy UUID that names no file is shown lower-cased in
`delete`'s "storage id … not found", as Convex parses it.
