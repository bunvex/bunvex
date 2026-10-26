# STUDY-162 — The custom test query's types and completions
<!-- index: The custom test query's types and completions: Convex's bundled `convex/server` and `convex/values` declarations, its editor's globals, generated data model and schema; bunvex's declarations as a lazy chunk made at build, the query's files from the deployment's schema, Monaco's type checking and suggestions; search and vector index names (§8) | implemented (owner, 2026-10-15: match Convex) -->

- **Status:** approved by the owner (2026-10-15: match Convex); implemented, §8 too (owner, 2026-10-15) (one PR: the declarations and the editor
  only work together)
- **Convex source read:** commit `d8bdde0` of get-convex/convex-backend; npm's `convex@1.46.0`
- **Related:** STUDY-149 PR 4 (the runner and its custom test query), STUDY-119 (`/api/run_test_function`), DV-390
  (`bunvex:/_system/repl/wrappers.js`), STUDY-160 (the packages' declarations), STUDY-36 (codegen)

The Functions screen's runner starts with "Custom test query": a query typed in TypeScript, compiled in the browser by
Monaco's TypeScript worker, run once (STUDY-149 PR 4). bunvex's editor checks its syntax only and offers no
completions; Convex's knows the deployment's types. This study is how Convex does it, and how bunvex will.

## 1. How Convex does it

All in the browser: no server route serves types. `dashboard-common/src/features/functionRunner/components/
FunctionEditor.tsx`:

- **The library's declarations, bundled.** `scripts/build-convexServerTypes.py` (run by each dashboard's
  `build:generated`) reads the `convex` package's built declarations (`dist/esm-types`): every `.d.ts` under
  `server/`, `values/` and `type_utils.d.ts`, each keyed `file:///convex/<path>` with its source-map comment cut,
  into `src/lib/generated/convexServerTypes.json` (about 265 KB). The editor imports it statically.
- **The editor's own files**, created as Monaco models in `beforeMount` (once per page):
  - `file:///globals.d.ts`: `declare global { const query: QueryBuilder<DataModel, "public">; const internalQuery:
    QueryBuilder<DataModel, "public">; const process: { env: { [key: string]: string | undefined; CONVEX_CLOUD_URL:
    string; CONVEX_SITE_URL: string } } }`, `QueryBuilder` from `./convex/server`, `DataModel` from
    `./_generated/dataModel`;
  - `file://_generated/server.d.ts`: `QueryCtx = GenericQueryCtx<DataModel>`;
  - `file:///_generated/dataModel.d.ts`, from the deployment's schema (below).
- **The deployment's schema.** `getSchemas` (subscribed): its `active` schema JSON, printed as TypeScript by
  `displaySchema(schema, "../")` into `file:///schema.ts` (`defineSchema({...})` with `defineTable`, the validators,
  `.index`, `.searchIndex`, `.vectorIndex`, staged ones), and `dataModel.d.ts` is codegen's "with schema" form
  (`DataModelFromSchemaDefinition<typeof schema>`, `Doc`, `Id`, `TableNames`). Without a schema, the "without schema"
  form (`AnyDataModel`, `Doc = any`). Both are replaced whenever the schema changes.
- **Compiler options** (`typescriptDefaults.setCompilerOptions`): `target: ESNext`, `moduleResolution: NodeJs`,
  `allowNonTsExtensions`, `isolatedModules`, `strict: true`, `typeRoots: ["file:///convex", "file:///_generated"]`.
  Diagnostics are Monaco's defaults: syntax and semantic errors are underlined.
- **What the user gets:** the editor (`path="/queryEditor"`, TypeScript) knows `query`, `ctx.db.query("<table>")`
  with the table names, `withIndex` with the index names and fields, documents typed by their table (`Doc`),
  `v` …; type errors are underlined; completions and hover come from Monaco's TypeScript worker. Running compiles
  with `getEmitOutput` (types erased) and prepends `import { query, internalQuery } from
  "convex:/_system/repl/wrappers.js";`, unchanged by the types.

## 2. What a user observes

In the custom test query: completions of the deployment's table and index names and of the API, hover types, and
type errors underlined (a table that does not exist, a field of the wrong type). Running is unchanged: a type error
does not stop the run (Convex compiles with the errors and runs).

## 3. bunvex, today

- `packages/ui/src/components/code-editor-monaco.tsx`: TypeScript models are compiled by Monaco's worker
  (`transpile`), with `noSemanticValidation: true` ("the app's types are not here, so a type error would be noise").
  No suggest contribution is imported, so even the worker's completions would not show.
- `packages/dashboard/src/runner/runner.tsx` `CustomTestQuery`: the editor and the run (`runTestQuery`, the preamble
  `bunvex:/_system/repl/wrappers.js`, DV-390).
- The pieces bunvex has: the package's declarations (`scripts/npm-packages.ts` `declarations`, STUDY-160, at
  release only: the workspace exports sources); the schema as `bunvex/schema.ts` code (`database/schema-code.ts`
  `schemaCode`, the Schema panel's, from `getSchema` — today without search and vector indexes, which the index list
  now has, STUDY-149 "Index list"); codegen's `dataModel.d.ts` forms (`packages/cli/src/codegen.ts`).

## 4. How bunvex does it

**The declarations** (`apps/dashboard/editor-types.ts`, run by a Vite plugin in `vite.config.ts` as the virtual
module `virtual:bunvex-query-types`): one TypeScript program emits the declarations of `@bunvex/server`,
`@bunvex/values` and the packages they import (`core`, `search`, `protocol`, `auth`, `file-storage`, `persistence`),
as STUDY-160's `declarations` does at release; only the files `bunvex/server` and `bunvex/values` reach are kept, keyed
`file:///node_modules/@bunvex/<package>/src/…`, with `index.d.ts` stubs (and one per subpath export) so Node's
resolution finds them, and `bunvex/server.d.ts`, `bunvex/values.d.ts` re-exporting them — the specifiers an app writes.
Measured on main: 149 files, 658 KB, a 673 KB chunk (190 KB gzipped), against Convex's 265 KB: `bunvex/server` also
exports the server (`createServer`, the engine's types), and its declarations reach `@bunvex/core`. So the chunk is
fetched the first time the custom test query opens (Convex bundles its types in the page). Nothing generated is
committed.

**The host hands them to the dashboard**: `Dashboard`'s new `queryTypes` prop (a loader); `apps/dashboard` passes
`import("virtual:bunvex-query-types")`. A host without it (tests, an embedding without the plugin) keeps today's
syntax-only editor.

**The query's own files** (`packages/dashboard/src/runner/query-types.ts`, `queryTypeFiles`), as Convex's: the globals
(`query`, `internalQuery`, `process.env` with `BUNVEX_CLOUD_URL` and `BUNVEX_SITE_URL`, the names bunvex's functions
read), `_generated/server.d.ts`, `_generated/dataModel.d.ts` in codegen's two forms, and `schema.ts` from `schemaCode`
(the Schema panel's text) — remade when the schema or the tables change (the runner's queries). The query's model is
`file:///testQuery.ts`.

**The editor** (`@bunvex/ui`'s `CodeEditor`, new `typescript: { path, files }`): every file an extra lib
(`setExtraLibs`), Convex's compiler options (`QUERY_COMPILER_OPTIONS`: ESNext, Node resolution, strict, isolated
modules), semantic diagnostics on, and Monaco's suggest and parameter-hint contributions; a value editor still offers
no suggestions. Running is unchanged (`transpileTypeScript`, the preamble): a type error does not stop the run, as
Convex's.

**Then built** (§8): the schema text's search and vector indexes, and the staged ones.

## 5. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| — | the declarations load with the custom query, not with the page | 673 KB; the page stays small | presentation, no owner question |

No observable divergence: the same completions and errors, in bunvex's names (rule 5).

## 6. Tests

- `apps/dashboard/test/editor-types.test.ts`: the declarations and the query's files given to TypeScript's own
  language service with the editor's options (what Monaco's worker says, without a browser): the bundle's entries and
  size, a query over the schema's table and index checks clean, a table the schema does not declare and a field of the
  wrong type are errors, the tables complete after `ctx.db.query("` and the indexes after `withIndex("`, no schema
  means any table, `process.env`'s URLs.
- `packages/sync-e2e/dashboard/app.e2e.ts` (Chromium, a live deployment): a field of the wrong type underlined, the
  query run anyway, a correct one clean, the table name in Monaco's suggestions.

**Sabotage** (each restored, `git diff` clean):

| Sabotage | Failing |
|---|---|
| the closure not following `@bunvex/*` specifiers | 5 of `editor-types.test.ts` |
| the data model always without a schema | 3 |
| `process.env` without `BUNVEX_CLOUD_URL` | 1 |
| semantic diagnostics left off in the editor | the Chromium test (no underline) |

**Measurements.** The declaration emit takes about 10 s of the dashboard's build (one TypeScript program over the eight
packages, once per build). The chunk: 673 KB, 190 KB gzipped, fetched only when the custom test query opens; the page's
own chunks are unchanged. In the browser, Monaco's worker reads the 149 files once.

## 7. Open questions

None for the owner: matching Convex. The chunk's size (673 KB, 190 KB gzipped, lazy) is reported for the record.

## 8. Search and vector index names (follow-up)

Approved by the owner on 2026-10-15.

**Convex.** `displaySchema` (`dashboard-common/src/lib/format.ts`, `displayTableDefinition`) writes a table from the
active schema JSON:
- `.index(name, [fields])` for each database index, then the staged ones as `.index(name, { fields, staged: true })`;
- `.searchIndex(name, {searchField, filterFields})` for each search index, then the staged ones (`staged: true`);
- `.vectorIndex(name, {vectorField, dimensions, filterFields})` for each vector index, then the staged ones;
- `filterFields` only when there are some;
- a database index's fields without the system ones (its schema JSON ends them with `_creationTime`).

The custom query's `schema.ts` is that text, so `withSearchIndex("…")` completes and checks the search indexes'
names, their search fields and their filter fields. A vector index has no use in a query (`vectorSearch` is an
action's), so its name only types the schema, as in Convex.

**bunvex before.** `schemaCode` wrote only the database indexes, from `TableInfo.indexes`, which also leaves out the
staged ones. So `withSearchIndex` completed nothing and accepted any name.

**As built.**
- The contract's `SchemaInfo.tables[].indexes` (`DeclaredIndexes`): the schema's own lists — database, search and
  vector, staged ones marked.
  - The server source reads them from the schema JSON (`declaredIndexesOf`: `indexes`, `stagedDbIndexes`,
    `searchIndexes`, `stagedSearchIndexes`, `vectorIndexes`, `stagedVectorIndexes`).
  - The mock reads them from its fixture.
- `schemaCode` writes them in Convex's order and form (`declaredIndexes`). It falls back to `TableInfo.indexes` for
  a source that gives none.
- The same text is the Database screen's schema panel, which now shows search, vector and staged indexes as
  Convex's schema view does.

**Tests.**
- `apps/dashboard/test/editor-types.test.ts`: the search index's name completes after `withSearchIndex("` (and a
  database index's does not); a name the schema does not declare is an error, and so is a search field that is not
  the index's; the vector index is written into `schema.ts`.
- `dashboard/test/schema-code.test.ts`: every kind, staged ones, the order, `filterFields` only when present, and the
  schema's lists winning over the table's.
- `dashboard-source/test/server-source.test.ts`: `schemaInfoOf` reads the six lists.
- `dashboard/test/database.test.tsx`: the schema panel shows the mock's staged index.
- Chromium on a live deployment (`app.e2e.ts`): the search index's name is in Monaco's suggestions after
  `withSearchIndex("`.

**Sabotage** (each restored, `git diff` clean): the source drops the search lists → 1 (`server-source.test.ts`);
`schemaCode` skips search indexes → 1 each in `schema-code.test.ts` and `editor-types.test.ts`; `staged` never
written → 1.

## 9. A run that hung: the worker restart (follow-up)

`app.e2e.ts`'s custom-query test failed now and then under load: once in a merge round (its 30 s wait), once in
CI (#704: "Succeeded in" never came, beside Bun's "timed out a request after 10 seconds" from the test's proxy).

**Root cause.**
- Monaco's TypeScript `WorkerManager` stops its worker on every `onDidChange` of the defaults (`setCompilerOptions`,
  `setDiagnosticsOptions`).
- A request pending on the stopped worker never settles: `webWorker.js` settles a reply only on the worker's answer,
  and `dispose` terminates without rejecting.
- `installTypeFiles` set both options at every new set of type files. That happened twice per page load, and again
  whenever the runner's tables or schema query came back with new data: a table's document count changing is enough,
  though the type files' content is the same.
- A compile (`getEmitOutput`) in flight at that moment hung for good: the run stayed "Running…". Load widens the
  window.

**Reproduced deterministically** on a live deployment, with the run clicked right after a table's size changed and a
focus refetch: the pre-fix code hangs, with the same Bun warning.

**Fix** (`code-editor-monaco.tsx`), two independent defences:
- The options change once, at the first types: the only restart. Later sets replace the extra libs only, which does
  not restart, and the same content changes nothing.
- A request the worker's restart overtakes is asked again (`untilSettled`, for the compile and for the readiness
  check).

**Readiness signal.** A typed editor says `data-types="checked"` once the worker has the files and has checked the
text once (`getSemanticDiagnostics`). The test waits on it before looking for type errors and completions, instead of
on a longer timeout.

**Tests and loop.**
- A regression test in `app.e2e.ts`: two runs, each clicked right after a table's size changed and the tables were
  refetched; each run must answer.
- Under 24 busy loops, two concurrent loops of the two tests passed 16 of 16 times; the pre-fix code hangs on the
  regression test every time.

**Sabotage.**
- The pre-fix code (no retry, a restart at every install, no same-content check): the regression test hangs and fails.
- Each defence alone (the retry alone; or the options once with the same-content check) keeps it passing, so both
  are kept as defence in depth.

