# STUDY-100 — Table names in `v.id`: autocomplete and checking (a proposed bunvex addition)

- **Status:** proposal (owner to decide); a bunvex addition, beyond Convex
- **Convex source read:** commit `4577b9031` of get-convex/convex-backend (`npm-packages/convex/src/values/validator.ts`);
  get-convex/convex-helpers `packages/convex-helpers/validators.ts` (main, 2026-10-04)
- **Related:** [STUDY-13](STUDY-13-validators.md) (validators), [STUDY-36](STUDY-36-codegen.md) (codegen).

## 1. How Convex does it

- **Core:** `v.id` is `<TableName extends string>(tableName: TableName) => VId<GenericId<TableName>>`
  (`values/validator.ts:151`). `v` comes from `convex/values`, which knows nothing of the app's tables, so an
  editor has no names to suggest, and a misspelled table name is not a type error. The id's type still flows
  (`Id<"_storage">` passes to `ctx.storage.getUrl` and to other `v.id("_storage")` arguments).
- **Codegen:** `_generated/dataModel.d.ts` exports `TableNames` and `Id<TableName>`, but no typed `v`.
- **convex-helpers** (the Convex team's utility library, outside the `convex` package): `typedV(schema)`
  (`validators.ts:452`) returns `v` with `id` restricted to the schema's tables and a new `doc(table)` (the
  table's document validator with its system fields). The app imports its schema into its functions:
  `const vv = typedV(schema)`. It does not include system tables (`vv.id("_storage")` is a type error), and it
  cannot be used in `schema.ts` itself.

## 2. What an app observes

Types only: what the editor suggests in `v.id("…")` and which names are errors. No runtime difference.

## 3. Measured (TypeScript's language service, the one editors use)

| `v.id` signature | Suggested in `v.id("` | Inferred type | A misspelled name |
|---|---|---|---|
| Convex's (today) | nothing | `Id<"_storage">` | accepted |
| `<T extends SystemTableNames \| (string & {})>(t: T)` | `_scheduled_functions`, `_storage` | the literal, kept | accepted |
| `<T extends TableNames \| SystemTableNames>(t: T)` (the app's tables, from codegen) | the system tables and the app's tables | the literal, kept | **a type error** |

## 4. Options (additions; none changes runtime)

| # | Addition | Where it helps | Cost |
|---|---|---|---|
| T1 | `v.id`'s signature suggests the system tables (`SystemTableNames \| (string & {})`): `_storage`, `_scheduled_functions` complete everywhere, `schema.ts` included; any other string still accepted | everywhere | a type change in `@bunvex/values`; compatible (same inference) |
| T2 | `_generated/server` exports `v`: bunvex's `v` at runtime, typed with the app's `TableNames \| SystemTableNames`, so in functions `v.id("` completes every table and a typo is a type error. Apps that import `v` from `bunvex/values` see nothing change | functions' `args` / `returns` | codegen templates and a type; not usable in `schema.ts` (the tables come from it) |
| T3 | `typedV(schema)` and `v.doc(table)`, as convex-helpers, with the system tables | apps porting convex-helpers code | belongs with a port of convex-helpers (several demos wait on it, STUDY-90) |

**Recommendation:** T1 and T2 now (small, type-only); T3 with the convex-helpers port.

## 5. Tests

Type tests (`tsc` on fixtures, as the codegen tests do): T1 — the system tables are assignable, any string still
is, the literal is inferred; T2 — a generated `_generated/server.d.ts` rejects a misspelled table and accepts
every table and system table; the language-service probe of §3 as a test (completions at `v.id("`).
