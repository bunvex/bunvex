# STUDY-180 — The names `bunvex/server` and `bunvex/values` export, against Convex's
<!-- index: The names `bunvex/server` and `bunvex/values` export, against Convex 1.46.0's: the 65 missing ones, 60 brought in with Convex's shapes (the storage interfaces, generic vector search types, `SchemaDefinition` with `doc` / `id`, `FieldTypeFromFieldPath` over unions, `SearchFilter` a runtime class, `asObjectValidator` in `bunvex/values`, …); a name check against the installed `convex` package and type-level comparisons; the five deprecated names not built (DV-543) | implemented (owner, 2026-10-20: every public name matches Convex's shape; DV-543) -->

- **Status:** decided (owner, 2026-10-20): every public name matches Convex's shape; the five deprecated ones are
  not built (DV-543).
- **Convex source read:** the `convex` npm package 1.46.0 (the client bunvex matches, STUDY-139), its public types
  `dist/esm-types/{server,values}/*.d.ts`. That version is the one the differential suite installs.
- **bunvex source:** `main` at `e3cad7d3`. Paths are relative to `packages/`.
- **Related:**
  - [STUDY-158](STUDY-158-own-components.md) G2: component packages import these names;
  - DV-312: the client's and the values' renamed names;
  - DV-538: rule 5.

## 1. How Convex does it

`convex/server` exports 172 names and `convex/values` 40, counted from the type checker's view of each `index.d.ts`
(values and types together). Only two of the names missing from bunvex are runtime values:
- `SearchFilter`, an abstract class;
- `asObjectValidator`, a function.

All the others are types, or classes Convex exports as types only (`TableDefinition`, `SchemaDefinition`,
`FilterExpression`). None of them is `@internal`. Five are `@deprecated`:
- `StorageId` and `FileStorageId`: ids from before 1.6;
- `FileMetadata`: the return type of the deprecated `storage.getMetadata`;
- `ValidatedFunction` and `UnvalidatedFunction`: the old function-definition types.

## 2. What an app can observe

A type an app or a component package names (`import type { UserIdentity } from "bunvex/server"`) must exist, and be
the same shape. An app that compiled against Convex then compiles against bunvex after the import rename. Component
packages (STUDY-158) use most of them, e.g. `GenericSchema`, `SchemaDefinition`, `PaginationOptions`,
`asObjectValidator`.

## 3. How bunvex does it

65 names are missing: 58 from `bunvex/server` and 7 from `bunvex/values`. The names renamed on purpose
(`ConvexError`, `convexToJson`, `jsonToConvex`, `getConvexSize`; DV-312) are not counted.

| Class | Count | What is done |
|---|---|---|
| Exported as is (same shape, internal today) | 18 | Re-exported from the entry point: `Auth`, `AuthConfig`, `AuthProvider`, `BetterOmit`, `Expand`, `GenericSchema`, `GenericTableIndexes`, `GenericTableSearchIndexes`, `GenericTableVectorIndexes`, `IdField`, `SearchFilterBuilder`, `SearchFilterFinalizer`, `TableDefinition`, `UserIdentity`, `ArgsArrayForOptionalValidator`, `DefaultArgsForOptionalValidator`, `ReturnValueForOptionalValidator`, `ValidatorTypeToReturnType` |
| Adapted (exists, another shape) | 16 | Brought to Convex's shape (§3.1) |
| Defined (new) | 26 | Written to Convex's shape: `Cursor`, `DefineSchemaOptions`, `EnvFromDefinition`, `FieldTypeFromFieldPathInner`, `FilterExpression`, `FunctionReference_future`, `GenericIndexFields`, `GenericSearchIndexConfig`, `GenericVectorIndexConfig`, `IndexTiebreakerField`, `NamedSearchIndex`, `NamedVectorIndex`, `PartialApi`, `SearchIndexConfig`, `SearchIndexNames`, `SearchIndexes`, `UserIdentityAttributes`, `VectorIndexConfig`, `VectorIndexNames`, `VectorIndexes`, `VectorSearch`, `AsObjectValidator`, `ObjectFieldType`, `RecordKeyValidatorJSON`, `RecordValueValidatorJSON`, `VOptional` |
| Deprecated | 5 | Not built (DV-543) |

### 3.1 The adapted ones, and the risks

- **Storage.** `StorageReader`, `StorageWriter` and `StorageActionWriter` are inferred from the implementation today
  (`server/src/functions.ts:418-420`):
  - ids are typed `string`, not `Id<"_storage">`;
  - `store` returns `Promise<string>`;
  - `StorageWriter` has a `store` that Convex's lacks; it throws outside actions.

  They become declared interfaces in Convex's shape. `ctx.storage` in a query or mutation is typed by them, so `store`
  is no longer offered there. `getMetadata` keeps its return type internally, without exporting `FileMetadata`.
- **Search and vector types.**
  - `VectorSearchQuery` and `VectorFilterBuilder` become generic over the table and index
    (`server/src/registration.ts:196-202`), so a filter is typed by the index's filter fields.
  - `ctx.vectorSearch` uses the new `VectorSearch` type.
- **`SchemaDefinition`.** It gains `doc()` and `id()` and Convex's type parameters, without defaults
  (`core/src/schema.ts:563`).
- **`FieldTypeFromFieldPath`.** It distributes over union documents and clamps to a value, as Convex's
  (`core/src/database-types.ts:25`).
- **`ExpressionOrValue`.** `@bunvex/core` already exports this name with another meaning (`core/src/filter.ts:43`).
  The entry points export the Convex-shaped `ExpressionOrValueOf` under Convex's name; core's own name is renamed
  inside core.
- **`SearchFilter`.** It becomes a runtime abstract class that the search filter builder's objects extend, as
  Convex's.
- **`asObjectValidator` and `NumericValue`.** Both move to `@bunvex/values` with Convex's signature. The server's
  private copy goes.
- **`PaginationOptions`.** It is exported without core's extra `id?`. The validator keeps `id`, as Convex's.
- **`DefaultFunctionArgs`.** It becomes `Record<string, unknown>`, from `any`.
- **`AuthProvider`.** It drops the extra `type: "oidc"` branch only if nothing accepts it at runtime. Otherwise it
  keeps it: it only accepts more.
- **`AnyChildComponents`**, **`RouteSpecWithPath`** and **`RouteSpecWithPathPrefix`** are names for shapes bunvex has.
- **`SearchIndexes` and `VectorIndexes`.** The names are taken in core by runtime classes
  (`core/src/search-indexes.ts:100`, `vector-indexes.ts:72`). The type-level maps are defined in core under other
  internal names, and exported under Convex's.

### 3.2 A check that keeps them matched

A test lists Convex's exported names (from the installed `convex` 1.46.0's `.d.ts`, the same type-checker walk this
study used) and bunvex's. It fails on a missing name not in this study's lists: the rule-5 renames and DV-543.
Type-level tests compare the shapes of the adapted ones against Convex's, with the type checker
(`expectTypeOf`-style assignability both ways).

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| DV-543 | `bunvex/server` does not export Convex's deprecated `StorageId`, `FileStorageId`, `FileMetadata`, `ValidatedFunction` and `UnvalidatedFunction` | CLAUDE.md: do not build what Convex keeps only for older clients | owner, 2026-10-20 |

## 5. Tests

- The name check (§3.2), in `bun run test`.
- The type-level comparisons, in `bun run typecheck`.
- Behaviour:
  - `ctx.storage.store` is absent from the types in a query or mutation;
  - a vector filter on a field not in the index fails to compile;
  - `SearchFilter` is a class at runtime.
