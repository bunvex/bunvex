---
"@bunvex/core": patch
"@bunvex/server": patch
---

Nested calls count their reads as Convex's backend does (STUDY-161 §16.7): only the first nested call in a transaction reads its callee's start (two reads, one more from a component, one more into another namespace, and the callee's modules), later ones nothing; resolving a component reference is not counted.
