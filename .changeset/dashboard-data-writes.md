---
"@bunvex/server": patch
---

The dashboard's Data screen writes, as Convex's system functions: `_system/frontend/addDocument`,
`patchDocumentsFields`, `replaceDocument`, `deleteDocuments`, `clearTablePage` and `createTable` (admin keys with
`WriteData`), with Convex's arguments, answers, limits (4 096 documents per insert or delete, 4 000 per clear page)
and refusals, each recording Convex's deployment audit event (`add_documents`, `update_documents`,
`delete_documents`, `create_table`) with the documents' ids.
