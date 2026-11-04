---
"@bunvex/core": patch
---

`Engine.createHiddenTable` takes a `namespace` (a component's id), and `activateTables` replaces a hidden table's same-named table in its own namespace and deletes `{ name, namespace }` entries. Stale hidden tables are cleaned up in every namespace, not only the root's.
