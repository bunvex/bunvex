---
"@bunvex/auth": patch
"@bunvex/core": patch
"@bunvex/protocol": patch
"@bunvex/server": patch
"@bunvex/values": patch
---

`bunvex/server` and `bunvex/values` export every name Convex 1.46.0's `convex/server` and `convex/values` export, with Convex's shapes (STUDY-180), but the rule-5 renames and the five deprecated ones (DV-543). `ctx.storage` is typed by `StorageReader`, `StorageWriter` and `StorageActionWriter`: a query's or a mutation's has no `store`, and ids are `Id<"_storage">`. `ctx.vectorSearch` is typed by the table's vector indexes and a filter by the index's filter fields. `SchemaDefinition` has `doc()` / `id()`; `FieldTypeFromFieldPath` goes over each member of a union; `SearchFilter` is a class the search filter builder's objects extend; `asObjectValidator`, `NumericValue` and `VOptional` are in `bunvex/values`, and `v.optional` returns a `VOptional`. `DefaultFunctionArgs` is `Record<string, unknown>`.
