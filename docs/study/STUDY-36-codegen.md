# STUDY-36 — Codegen: `_generated/` and the typed data model

- **Status:** draft
- **Convex source read:** commit `4577b9031` of get-convex/convex-backend.
- **Related:**
  - ARCH-01 open decision 1, decided 2026-10-02 by the owner: generate `_generated/` like Convex.
  - [STUDY-26](STUDY-26-sync-client.md) C3: function references live in `@bunvex/protocol` and are generic,
    so codegen plugs in.
  - [STUDY-35](STUDY-35-push-and-deploy.md): push, analysis, `bunvex deploy`, `bunvex/`.
  - [platform §13](../parity/platform.md#13-codegen-convex_generated) and server-api §5, §8, §10, §11.

Paths are relative to `npm-packages/convex/src/cli/`.

## 1. How Convex does it

### 1.1 The files

An app's `convex/_generated/` holds five files. By default they are `.js` + `.d.ts` pairs; with `codegen.fileType: "ts"` they are `.ts` files (`lib/config.ts:140, 289`). Each file starts with a header ("THIS CODE IS AUTOMATICALLY GENERATED. To regenerate, run `npx convex dev`.") and is formatted with prettier. A file is only rewritten when its content changes (`lib/codegen.ts:913-956`).

**`api.js`** is `export const api = anyApi; export const internal = anyApi; export const components = componentsGeneric();`.

**`api.d.ts`** in dynamic mode (the default):
- `import type * as messages from "../messages.js";` for every module;
- `declare const fullApi: ApiFromModules<{ messages: typeof messages, "foo/bar-baz": typeof foo_bar_baz }>`;
- `export declare const api: FilterApi<typeof fullApi, FunctionReference<any, "public">>`, and the same for `internal`;
- `export declare const components: {}`.

The key is the path without its extension (so `api.foo["bar-baz"]`), and the identifier is the path with `/` and `-` replaced by `_`.

**`server.js` / `server.d.ts`** re-export the builders typed by the data model:
- `export const query = queryGeneric`, …;
- `export declare const query: QueryBuilder<DataModel, "public">`, …;
- `httpAction`;
- the context types `QueryCtx`, `MutationCtx`, `ActionCtx`, `DatabaseReader`, `DatabaseWriter`;
- `env` (typed environment variables).

**`dataModel.d.ts`** exports:
- `TableNames`, `Doc<T>`, `Id<T>` (`GenericId`) and `DataModel = DataModelFromSchemaDefinition<typeof schema>` (importing `../schema.js`);
- without a schema: `Doc = any`, `TableNames = string`, `DataModel = AnyDataModel`.

**Static modes** (`staticApi`, `staticDataModel`) write the types out from the push's analysis (validator JSON → TS) instead of computing them from the code.

### 1.2 When it runs

**Initial codegen** runs before bundling. It writes stubs only where files are missing, and always `api.js`, so that user code that imports `./_generated/server` bundles. **Final codegen** runs after `start_push` from its analysis. Then comes the typecheck (`tsc --noEmit` with `convex/tsconfig.json`, mode `enable` / `try` / `disable`, default `try`), then the push finishes.

`convex codegen` runs a `start_push` it never finishes, so it needs a running deployment. `--init` writes `convex/tsconfig.json` and a `README.md`. `_generated/` is never an entry point, but user modules that import it bundle it.

### 1.3 The types behind it (npm-packages/convex/src/server, values)

These are the types and values the generated files rely on:
- **values:** `GenericId<T>` (a branded string).
- **schema:**
  - `defineSchema` / `defineTable` keep the document validator and the indexes as type parameters;
  - `DataModelFromSchemaDefinition`, `DocumentByName`, `TableNamesInDataModel`, `SystemTableNames`, `AnyDataModel`, `GenericDataModel`;
  - `WithoutSystemFields`, `WithOptionalSystemFields`, `SystemFields`.
- **db:** `GenericDatabaseReader<DM>` / `GenericDatabaseWriter<DM>`:
  - `get(id: Id<T>)` returns `Doc<T> | null`;
  - `query(table)` with index names and fields checked, and `filter` over field paths;
  - `insert(table, WithoutSystemFields<Doc>)` returns `Id<T>`.
- **functions:**
  - `RegisteredQuery` / `RegisteredMutation` / `RegisteredAction`, which carry kind, visibility, args and returns;
  - `QueryBuilder<DM, V>` and the others;
  - `queryGeneric` … `httpActionGeneric`;
  - `GenericQueryCtx` / `GenericMutationCtx` / `GenericActionCtx`, with `runQuery` / `runMutation` / `runAction` and `scheduler` typed by `FunctionReference`.
- **api:** `ApiFromModules`, `FilterApi`, `FunctionReference`, `AnyApi`.

## 2. What an app can observe

1. **The generated files are present.** Apps import `./_generated/server` (`query`, `mutation`, `QueryCtx`, …), `./_generated/api` (`api`, `internal`) and `./_generated/dataModel` (`Doc`, `Id`). Without those files they do not compile, and with plain `bunvex/server` builders they compile untyped.
2. **The types themselves.**
   - Mistakes are caught at compile time: a wrong table, index or field, a document of the wrong shape, wrong arguments to `useQuery(api.x.y, …)`.
   - Results are typed: `useQuery`'s value, `db.get`'s document, `db.insert`'s `Id<T>`.
3. **What is in each file.** Imports, names and the module → key mapping are what an app's code and editor see.

## 3. How bunvex does it

### 3.1 What exists

**The client is ready.**
- `FunctionReference<Type, Visibility, Args, Return>`, `FunctionArgs`, `FunctionReturnType`, `OptionalRestArgs`, `anyApi` and `makeFunctionReference` are in `@bunvex/protocol`.
- `useQuery`, `useMutation`, `ConvexHttpClient`'s counterpart and the base client are typed against them.

**Validators are precise:** `Infer`, `ObjectType`, and `v.id(t)` infers `string & { __tableName: t }`.

**The server erases every type.**
- Builders return a non-generic `FunctionDef`.
- Contexts and `Tx` take strings and return `Doc`.
- `defineTable` / `defineSchema` keep no type parameters.
- `runQuery` and `scheduler.runAfter` take untyped references.

**No `_generated/` and no codegen.**

### 3.2 The design

**Types first, mirroring Convex's names and shapes** (the generated files import them, and apps name them):

1. **`@bunvex/values`:** `GenericId<T>`, and `v.id(t)` returns `VId<GenericId<t>>`.
2. **`@bunvex/core`:**
   - generic `TableDefinition<Document, Indexes>` and `SchemaDefinition<Tables, Strict>`;
   - `DataModelFromSchemaDefinition`, `GenericDataModel`, `AnyDataModel`, `DocumentByName`, `TableNamesInDataModel`, `NamedTableInfo`, `SystemTableNames`;
   - `SystemFields`, `WithoutSystemFields`, `WithOptionalSystemFields`;
   - `GenericDatabaseReader<DM>` / `GenericDatabaseWriter<DM>` and a typed `QueryInitializer`, `IndexRangeBuilder` and `FilterBuilder`.

   These are type-level views of the existing `Tx`. The runtime does not change.
3. **`@bunvex/server`:**
   - `GenericQueryCtx<DM>` / `GenericMutationCtx<DM>` / `GenericActionCtx<DM>`;
   - `RegisteredQuery` / `RegisteredMutation` / `RegisteredAction` (the `FunctionDef` with phantom kind, visibility, args and returns);
   - `QueryBuilder<DM, V>` and the others;
   - `queryGeneric` … `httpActionGeneric` (the existing builders, typed);
   - `runQuery` / `runMutation` / `runAction` / `scheduler` typed by reference.

   `query` and friends stay `queryGeneric` over `AnyDataModel`.
4. **`@bunvex/server`:** `ApiFromModules`, `FilterApi` (as built: they read the registered-function types, so they live beside them); `AnyApi` stays in `@bunvex/protocol`.

**Codegen** lives in `@bunvex/cli` (`codegen.ts`). The generated files carry the same content as Convex's, importing from `bunvex/server` and `bunvex/values`:
- **The files:** `api.js` / `api.d.ts`, `server.js` / `server.d.ts`, `dataModel.d.ts`, and with `bunvex.json` `codegen.fileType: "ts"` the `.ts` variants.
- **Static modes:** `staticApi` and `staticDataModel`, from the analysis.
- **`bunvex codegen [--init] [--typecheck]`:** `--init` writes `bunvex/tsconfig.json` and `bunvex/README.md`.
- **`bunvex deploy`** runs the initial codegen before bundling and the final one from `start_push`'s analysis. It typechecks (`tsc --noEmit`, `try` by default) before `finish_push`, as Convex.
- **Where the analysis comes from (G1):** `bunvex codegen` loads the modules locally with the server's own loader (`CodeVersion`), so it needs no running deployment. `bunvex deploy` uses `start_push`'s analysis.
- **The files themselves:**
  - the header reads "To regenerate, run `bunvex dev`" (or `bunvex codegen`);
  - formatting is the generator's own, matching prettier's output for these files; prettier is not a dependency (G3);
  - `components` is exported as an empty object while bunvex has no components (G2);
  - `env` is typed `Record<string, string | undefined>` until deployment environment variables (item 9) give it its names (G4).

**Tests:**
- **Type tests:** a fixture app is compiled by `tsc` in `bun run check`, with assertions written as `// @ts-expect-error` and `expectType`.
- **Golden files** for the generated output.
- **End to end:** `bunvex deploy` writes `_generated/`, and the fixture app typechecks against it.

### 3.3 PRs

1. Values and schema types: `GenericId`, the generic schema, `DataModelFromSchemaDefinition`, and the system-field helpers.
2. The typed database: reader, writer, query, index range and filter builders.
3. Typed functions: contexts, registered functions, builders and `*Generic`; typed `runQuery` and scheduler; `ApiFromModules` / `FilterApi`.
4. Codegen: the generator, golden files, `bunvex codegen`, `--init`, codegen in `bunvex deploy`, and the typecheck step.

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| G1 | `bunvex codegen` needs no running deployment. Convex's `codegen` runs a `start_push` against the deployment and refuses without one. Its dynamic modes (the default) need only the list of modules and whether `schema.ts` exists, so bunvex writes them from the code alone. The static modes, which need the analysis, are not implemented yet | codegen works offline, and in CI before a deployment exists; the output is the same | pending |
| G2 | `components` is `{}` in `api` while bunvex has no components (Convex: `componentsGeneric()`) | there is nothing to reference; components are Phase 4 | pending |
| G3 | The generated files are laid out by the generator itself, not by prettier | no prettier dependency; the layout matches prettier's for these files, but a user's prettier config is not applied | pending |
| G4 | `env` in `_generated/server` is `Record<string, string \| undefined>` until deployment environment variables exist; Convex types `CONVEX_CLOUD_URL`, `CONVEX_SITE_URL` and the declared ones | the names come with item 9 (environment variables); rule 5 rules out Convex's names | pending |
| G5 | The generated `tsconfig.json` (`codegen --init`) adds `"allowImportingTsExtensions": true` to Convex's settings | bunvex's packages are TypeScript sources whose files import each other by `.ts` paths, and an app's `tsc` checks them too. Without the setting, every bunvex import fails and the app's types silently become `any`. The alternative is to publish built `.d.ts` files for every package (a build step), after which the setting is no longer needed | pending |

## 5. Tests

- **Type assertions** on a fixture app:
  - `Doc<"messages">`, `Id<"messages">`;
  - `db.get` / `insert` / `withIndex` / `filter` checked;
  - `useQuery(api.messages.list, …)` arguments and result;
  - `runQuery` and the scheduler.
- **Golden files** for each mode, with and without a schema, and for nested and dashed module names.
- **Re-running codegen** leaves unchanged files untouched.
- **End to end:** `bunvex deploy` of the example app writes `_generated/`, and `tsc` passes on the app.

## 6. Open questions

- **Typecheck in `deploy`** needs TypeScript available. Use the project's own `typescript` when installed, and skip with a warning otherwise, as Convex's `try` does.
