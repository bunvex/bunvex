---
"@bunvex/core": patch
---

A write past a document limit fails with Convex's message. An array over 8192 elements or an object over 1024 fields in `db.insert`, `db.patch` or `db.replace` is "Invalid argument \`value\` for \`db.<method>\`: …". A document nested over 16 levels or with a top-level field starting with `_` is "Document(value: {…}) isn't a valid document: …", with every violation.
