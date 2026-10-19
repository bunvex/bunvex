# STUDY-156 — Components: the CLI's push and codegen (STUDY-152 step 6)

- **Status:** decided (owner, 2026-10-19): Q-1 codegen offline from the validators (DV-532), Q-2 bunvex's
  resolution conditions (DV-533), Q-3 no `legacyComponentApi` (DV-534), Q-4 `run --component` in step 6 (§5); DV-535
  (a nested local component's import, found while building PR 2).
- **Convex source read:** `d8bdde0`, the reference commit (docs/parity/upstream.md). Paths are relative to
  `npm-packages/convex/src/cli/`.
- **bunvex source:** `main` after STUDY-155 (`b6bc9ecc`). Paths are relative to `packages/`.
- **Scope.** What `bunvex dev` / `deploy` send for an app that mounts components, and what `bunvex codegen`
  writes for it:
  - finding the definitions;
  - bundling them;
  - the push and what it prints;
  - `_generated/` with `components`;
  - a local component's own `_generated/`;
  - the CLI flags that refuse components today: DV-385, DV-391, and DV-224 (left to step 9).

  It closes DV-429 and DV-174. The server's side was built in STUDY-153 to STUDY-155.
- **Related:**
  - [STUDY-153](STUDY-153-component-push.md): C-1, C-7, C-8, and §2.5 (what the CLI must send);
  - [STUDY-36](STUDY-36-codegen.md): G1 and G2;
  - [STUDY-116](STUDY-116-codegen-flags.md): F2;
  - [STUDY-119](STUDY-119-run-inline-query.md): I3.

## 1. How Convex does it

### 1.1 One push path, with or without a config

- **One path.** `runPush` always runs the components push (`lib/components.ts:149-152` → `runComponentsPush`,
  `:612-684`).
- **No `convex.config.ts`.** The functions directory is still a component root, marked `isRootWithoutConfig`
  (`lib/components/definition/directoryStructure.ts:77-132`).
  - The graph is the root alone (`bundle.ts:286-296`).
  - A virtual plugin serves `defineApp()` as its definition (`bundle.ts:31-32, 44-92, 490-506`).
  - So every push sends a real `appDefinition.definition`. This is what DV-429 lacks.

### 1.2 Finding the definitions

`componentGraph` (`lib/components/definition/bundle.ts:276-356`) runs one esbuild pass from
`./convex/convex.config.ts`, with `metafile: true`.

- **Build options** (`:236-272`): `bundle`, `platform: "browser"`, `format: "esm"`, `conditions:
  ["convex", "module"]`, `minify`, `keepNames`. The hidden `--live-component-sources` adds the condition
  `"@convex-dev/component-source"`.
- **The plugin** hooks every import matching `/.*convex.config.*/` (`:128-207`):
  - it tries `.js`, then `.ts`;
  - it checks that the parent directory is a component directory;
  - in discover mode, it lets the traversal continue.
- **The graph.** `findComponentDependencies` (`:387-460`) reads `metafile.inputs`:
  - every `.config.` input becomes a node, every import between two of them an edge;
  - `importSpecifier` is the import's original text without `/convex.config…`, e.g. `@convex-dev/workpool`.
- **A definition path** (`toComponentDefinitionPath`, `directoryStructure.ts:169-183`) is the component
  directory relative to the functions directory, POSIX, with symlinks resolved and no leading `./`:
  - `../node_modules/@convex-dev/workpool/dist/component` for a package, whose export condition points at `dist`;
  - `../components/foo` for a local one;
  - `""` for the root.
- **CLI errors:**
  - `Invalid component root directory (${why}): ${convexDir}` (`lib/components.ts:258-264`);
  - `Invalid component directory (${why}): …` (`directoryStructure.ts:145-151`);
  - `esbuild failed: …` (`bundle.ts:325-340`).

  The CLI has no check of its own for cycles or re-exported configs; the server's evaluation in `start_push`
  refuses them.

### 1.3 Bundling

- **Definitions** (`bundleDefinitions`, `bundle.ts:468-619`): one esbuild build for every config, in bundle mode.
  - Each import of a child's config becomes the external `./_componentDeps/<base64url(definitionPath)>`
    (`:208-233`).
  - `convex/server` is bundled in.
  - Each spec is `{definitionPath, definition: {path: "convex.config.js", source, sourceMap, environment:
    "isolate"}, dependencies}` (`:583-614`).
- **Implementations** (`bundleImplementations`, `bundle.ts:621-809`), for each directory:
  - `schema` from `schema.ts` / `schema.js`;
  - the isolate modules.
  - Only the root also gets Node modules, `externalNodeDependencies` and `auth.config`.
  - A component's `"use node"` module stops the push: `"use node" directive is not supported in components.
    Remove it from the component at: ${resolvedPath}.` (`:778-785`).
- **The request** (`lib/components.ts:399-450`):
  - `appDefinition` is `{definition, dependencies, schema, changedModules, unchangedModuleHashes,
    udfServerVersion}`, with the app's modules split by hash against `get_config_hashes`.
  - Each `componentDefinitions[]` entry is `{definitionPath, definition, dependencies, schema, functions,
    udfServerVersion}`, with every module sent and none hashed (`deployApi/definitionConfig.ts:6-23`).

### 1.4 The push and what it prints

- **Order:** `start_push` → `wait_for_schema` → `finish_push` (`lib/deploy2.ts:139-399`), the same as an app
  without components.
  - The CLI does not read `allocatedComponentIds`. It hands `schemaChange` back to `wait_for_schema` and the
    whole response to `finish_push`.
  - `wait_for_schema` sums the progress over `components` (keyed by path). A failure prints
    `Schema validation failed in component "${componentPath}".`
- **What it prints** (`printDiff`, `lib/components.ts:686-775`):
  - the root's index diff, as today;
  - a line per non-root component: `Installed component ${path}.` (create), `Unmounted component ${path}.`,
    `Remounted component ${path}.`, and nothing for `modify`.
  - `--dry-run` prints the same lines, and `--verbose` dumps the JSON.

### 1.5 Codegen

- **It needs a deployment.** `npx convex codegen` (`lib/components.ts:92-147`) runs `start_push` with
  `forCodegen` and never `finish_push`.
  - Without credentials it does nothing.
  - Every component type comes from `startPushResponse.analysis`: the server's evaluation, its validators turned
    into types.
- **Two phases.**
  - Before bundling, stubs (`lib/codegen.ts:218-308`): `api.js` is `export const components =
    componentsGeneric();` with `api` and `internal` as `anyApi` (`codegen_templates/component_api.ts:31-82`).
  - After `start_push`, the final files for the root and each **local** component (`lib/codegen.ts:327-497`).
    Published packages (a `.js` definition) are skipped: they ship their own `_generated/`.
- **The app's `components`** (`component_api.ts:118-174, 281-293`), by default (`codegen.legacyComponentApi`
  unset):

  ```ts
  export declare const components: {
    "workpool": import("@convex-dev/workpool/_generated/component.js").ComponentApi<"workpool">,
  };
  ```

  - One entry per child instance (`analysis.definition.childComponents`).
  - The import is the `importSpecifier` when it is a package; otherwise `../<definitionPath>`.
  - With `legacyComponentApi: true`, each child's exports are inlined instead: `FunctionReference<"mutation",
    "internal", Args, Returns>` built from the analysis (`:176-190, 506-594`).
- **A local component's `_generated/`.** These files are always `.ts`, whatever `codegen.fileType` says:
  - `api.ts`: its own `api` / `internal` and its children's `components`;
  - `server.ts`: no `components`, env vars typed from `definition.envVars` (`lib/codegen.ts:421-439`);
  - `dataModel.ts`;
  - `component.ts` (`component_api.ts:196-244`):

    ```ts
    export type ComponentApi<Name extends string | undefined = string | undefined> =
      { lib: { add: FunctionReference<"mutation", "internal", {…}, …, Name> } };
    ```

    It is built from `definition.exports`. Every reference is `"internal"`, and the fifth type parameter is the
    component path.
- **Flags:**
  - `--component-dir <dir>` (`lib/components.ts:267-332, 515-583`) generates and typechecks one component
    directory alone. It mounts the component as `exampleComponentInstance` under a synthetic app and sends
    `forCodegen`. A directory without a config fails: `Only directories with convex.config.ts files are
    supported, this directory does not: …`.
  - `--live-component-sources`: packages resolve to their `.ts` sources, which then get codegen.
  - `--typecheck-components` (`dev`, `deploy`, `run`): `tsc` in each local component directory.
- **`convex.json`** (`lib/config.ts:77-118`): `codegen.staticApi`, `codegen.staticDataModel` and
  `codegen.legacyComponentApi`. There is no key that lists component directories; the graph finds them.

### 1.6 Other commands

- **`run --component <path>`** sends `componentPath` to `/api/function` (`lib/run.ts:58-62`).
  - `--inline-query` resolves the path to an id through `_system/frontend/components:list`.
  - Its errors: ``--component` must not be empty.`` and `Component path "…" was not found.\n\nAvailable
    components:\n• …` (`run.ts:238-286`).
- **`data --component`** passes `componentPath` to `_system/cli/tables` / `tableData` (`lib/data.ts:27-100`).
- `logs` and `env` take no component.

## 2. What apps observe

- **Without a config,** a push behaves as before. The `_modules` table has a `convex.config.js` row for the app
  (DV-429's gap).
- **With one,** a push installs the components.
  - It prints `Installed component counter.` and the matching lines on later pushes.
  - `components.counter.lib.add` is typed from the component's own `_generated/component.js`.
- **A local component** gets its own `_generated/`, `component.ts` included.
- **The flags** `run --component`, `codegen --component-dir` and `--typecheck-components` work.

## 3. bunvex today

- **Push** (`cli/src/deploy.ts:486-661`):
  - no config is looked for;
  - `appDefinition.definition` is `null` (DV-429), and `dependencies` and `componentDefinitions` are `[]`
    (`:539-555`);
  - only `componentDiffs[""]` is printed (`:626`).
- **Bundling** (`cli/src/bundle.ts`): `Bun.build` with `bunvex`, `bunvex/*` and `@bunvex/*` external (`:33`).
  - A name with two dots, such as `bunvex.config.ts`, is never a function module (`:100`).
- **Codegen** (`cli/src/codegen.ts:176-335`) is static: it reads the source tree, with no deployment (DV-173).
  - `api` and `internal` are `ApiFromModules<…>` inferred by TypeScript.
  - `components` is `{}` in every variant (`:259-307`, DV-174).
- **Refused flags:**
  - `codegen --component-dir` / `--live-component-sources` (DV-385, `codegen-command.ts:49-51`);
  - `run --component` / `--typecheck-components` / `--live-component-sources` (DV-391, `run.ts:249-252`);
  - `data --component` (DV-224, `data.ts:156-158`).
- **The server is ready.**
  - `start_push` accepts Convex's request shape (`server/src/push.ts:200-220`,
    `push-components.ts:37-92`).
  - It answers with `analysis` (per definition: `childComponents`, `exports`, `envVars`, functions with their
    validators) and `app` (the instance tree), as Convex's.
  - `/api/function` runs a component's function by `componentPath` (STUDY-154).
- **Types.** bunvex's `FunctionReference` (`protocol/src/api.ts:16-26`) has four type parameters. Convex's has
  five, the fifth the component path, and every `ComponentApi` passes it. `componentsGeneric` and
  `AnyComponents` are in `bunvex/server` (`server/src/components.ts:235-257`).

## 4. How bunvex would do it

### 4.1 Finding and bundling the definitions

- **Discovery.** `Bun.build` from `bunvex/bunvex.config.ts`, with `metafile: true`. It gives the same graph as
  esbuild's (STUDY-152 §6.2).
  - A plugin on `bunvex.config` imports resolves `.js`, then `.ts`, and records each one.
  - A definition path is computed as Convex's: relative to the functions directory, POSIX, symlinks resolved.
- **Resolution conditions:** `["bunvex", "module"]`, and `--live-component-sources` adds
  `"@bunvex/component-source"` (Q-2).
- **Definitions.** A second build rewrites each child's config import to `./_componentDeps/<base64url>`, external.
  - `bunvex/server` and `bunvex/values` stay external (DV-495, which the server already links).
- **No config:** the virtual `defineApp()` definition (STUDY-153 C-8), which closes DV-429.
- **Implementations.** Each directory's schema and modules come from the existing `bundle()`, unchanged.
  - Node modules, `auth.config` and node dependencies are bundled for the root only.
  - A component's `"use node"` stops the push with Convex's text.
- **The request** is Convex's shape:
  - each component sends all its modules;
  - the app still splits its modules by hash.

### 4.2 The push

- `waitMessage` and a failure name the component's path: `Schema validation failed in component "counter".`
- After `finish_push`, the root's index diff is printed as today, then Convex's lines for each non-root
  `componentDiffs` entry.
- `--dry-run` prints the same lines.

### 4.3 Codegen

bunvex's codegen stays offline (DV-173), and builds a component's types from its validators, as Convex's
(Q-1, DV-532). Everything Convex reads from the server's analysis, the CLI reads from the same bundle in Bun:

- **The definitions.** The CLI imports the bundled definitions (§4.1) in Bun.
  - `defineApp` / `use` / `export()` are pure (STUDY-153 PR 1).
  - This gives each definition's `childComponents`, `exports` and `envVars`, as the server evaluates them at push
    time.
- **The functions.** The CLI imports each local component's bundled modules and reads each export's kind,
  visibility and `exportArgs()` / `exportReturns()` (`server/src/builders.ts:64-71`). This is the server's
  analysis without a deployment.
- **`components`** is Convex's default form:
  `import("<specifier>/_generated/component.js").ComponentApi<"<name>">`, or `../<definitionPath>/…` for a local
  component.
  - `api.js` / `api.ts` export `componentsGeneric()` from `bunvex/server`.
- **A local component's `_generated/`** holds `api.ts`, `server.ts`, `dataModel.ts` and `component.ts`, always
  `.ts`, as Convex's.
  - `component.ts` is written out, as Convex's: `FunctionReference<"mutation", "internal", Args, Returns, Name>`,
    with `Args` and `Returns` turned from the validators into types (`any` without one).
  - So it stands alone: a consumer's `tsc` does not read the component's modules.
  - `server.ts` types the env vars from the definition's `envVars`.
- **`FunctionReference` gets Convex's fifth parameter** (`ComponentPath = string | undefined`). Existing
  four-parameter uses keep compiling.
- **The flags:**
  - `--component-dir` generates and typechecks one directory, mounted as `exampleComponentInstance` (Convex's
    name), without a deployment;
  - `--live-component-sources`, as §4.1;
  - `--typecheck-components` on `dev` / `deploy` / `run`.
- **Not built:** `codegen.legacyComponentApi` (Q-3, DV-534), nor `staticApi` / `staticDataModel` for the app,
  which are already DV-173.
- **A module that throws when imported** stops codegen with its error. Convex reports the same error from its
  `start_push`.

### 4.4 `run --component`

`run --component <path>` sends `componentPath` to `/api/function` (Q-4).

- `--inline-query` resolves the path through `_system/frontend/components:list` and sends `componentId` to
  `run_test_function` (built in STUDY-154 PR 3).
- The errors are Convex's texts, in bunvex's words.

## 5. Questions for the owner

| # | Where bunvex would differ | Convex | Recommendation | Decision |
|---|---|---|---|---|
| Q-1 | **Codegen of components without a deployment.** `component.ts` and `components` come from the CLI's own evaluation (the bundled definitions and the functions' validators, read in Bun), not from a `start_push` | runs `start_push` (`forCodegen`) and builds the types from the server's analysis (validators) | Offline, from the validators. The CLI evaluates the bundles Convex's server would, and writes Convex's file from what the validators say (`any` without one), self-contained. Codegen keeps working without a deployment. (A first proposal inferred the types with TypeScript; the owner preferred Convex's file) | **Decided (owner, 2026-10-19): offline, from the validators** (DV-532) |
| Q-2 | **Package resolution conditions:** `"bunvex"` (and `"@bunvex/component-source"` for `--live-component-sources`) | `"convex"`, `"@convex-dev/component-source"` | bunvex's names (new DV, rule 5). No published Convex component uses either condition (STUDY-152 §6.1), and bunvex's own `@bunvex/*` packages (C1) will use bunvex's | **Decided (owner, 2026-10-19): bunvex's names** (DV-533) |
| Q-3 | **`codegen.legacyComponentApi`** | inlines each child's API instead of importing its `ComponentApi` | Not built (new DV): it is the older form, and the static modes it builds on are DV-173 already. An app on it switches to the default by removing the key | **Decided (owner, 2026-10-19): not built** (DV-534) |
| Q-4 | **When `run --component` and `--typecheck-components` arrive** | — | Now, in step 6 (closes DV-391's CLI half). The server has run them since STUDY-154. `data --component` (DV-224) stays in step 9 with the dashboard, since `_system/cli/tables` needs a component there | **Decided (owner, 2026-10-19): in step 6** |

## 6. Proposed PRs

1. **cli: push an app's components.**
   - Discovery and bundling (§4.1), the virtual `defineApp()` (closes DV-429), the request, and the printed lines
     (§4.2).
   - Tests: an app with a local component and with a package component (a fixture in `node_modules`) is pushed
     and its function runs; a push without a config stores the `bunvex.config.js` row; a component's
     `"use node"` is refused; an unmount prints its line; `--dry-run`.
2. **cli: codegen for components.**
   - `components` (closes DV-174), a local component's `_generated/` with `component.ts` from the validators,
     the fifth `FunctionReference` parameter, `--component-dir` and `--live-component-sources` (closes DV-385).
   - Tests: the generated files and their typecheck (an app calling `components.counter.lib.add` with wrong
     arguments fails `tsc`); `--component-dir` on a component without an app.
3. **cli: `run --component` and `--typecheck-components`** (DV-391's CLI half, Q-4).

### As built, PR 1 (`cli/src/components.ts`, `bundle.ts`, `deploy.ts`)

- **Finding and bundling.**
  - `bundleComponents` builds the app's `bunvex.config.ts` (or `.js`) once with a metafile, under the conditions
    `["bunvex", "module"]`.
  - Every non-external import whose specifier names `bunvex.config` is a child, walked breadth first.
  - A child that resolves to a file other than `bunvex.config.ts` / `.js` is `Invalid component directory
    (Component definition bunvex.config.ts isn't a file): <dir>`.
  - Each definition is bundled on its own. A plugin maps each `(importer, specifier)` that the metafile resolved
    to `./_componentDeps/<base64url(path)>`, external, so the server links it.
  - Each component's functions and schema go through `bundleFunctions(dir, project, { component: true })`: no
    `auth.config`, and a `"use node"` module is Convex's error.
- **No config:** Convex's virtual `defineApp()`, sent as source (`bunvex/server` stays external, DV-495). This
  closes DV-429: `get_config_hashes` and `_modules` now list `bunvex.config.js`.
- **The push** sends the app's definition and dependencies, and each component with every module and the CLI's
  version.
  - It prints `Installed component <path>.`, `Unmounted component <path>.` and `Remounted component <path>.` for
    each non-root `componentDiffs` entry, and nothing for `modify`.
  - A component's failed schema prints `✖ Schema validation failed in component "<path>".` with the error.
  - `--dry-run` is bunvex's, as before: it ends at `start_push` and prints no component lines. Convex's goes on
    to `finish_push` with `dryRun`.
- **Measured.** Bundling an app with no config costs nothing more: no build runs. An app with two components
  (one local, one from a package, one nested) adds about 3.9 ms to the push's bundling, against 0.9 ms for the
  app's own functions (10 runs, warm).
- **Tests.** `cli/test/component-push.test.ts`, 7 cases:
  - the graph and its paths;
  - the `_componentDeps` imports;
  - no config;
  - `"use node"`;
  - a push installing a local component, a package component and a nested one, whose functions then run;
  - an unmount's line, and no line for a push that changes nothing;
  - a component's schema failure;
  - DV-429's `_modules` row.

  Sabotage: 7 of 7 broken fixes were caught.
- **Not yet.** `bunvex dev` watches only the functions directory, so a local component outside it is pushed
  again only when a file in the functions directory changes. Watching the definitions' directories comes with
  PR 2's codegen.

### As built, PR 2 (`cli/src/component-codegen.ts`, `codegen.ts`, `codegen-command.ts`, `deploy.ts`, `dev.ts`; `server/src/push.ts`; `protocol/src/api.ts`)

- **The analysis without a deployment.** `PushService`'s component evaluation is now the standalone
  `evaluateComponents`, and `componentAnalysis(appDefinition, componentDefinitions)` in `@bunvex/server` returns
  what `start_push` answers as `analysis`.
  - It reuses the server's code: module analysis, definition evaluation and the tree check, `forCodegen`, with no
    engine.
  - `bunvex codegen` bundles the definitions as a push does and reads that analysis (DV-532).
  - `deploy` and `dev` read the deployment's own `start_push` answer, as Convex's final codegen does.
- **`components`.**
  - `api.js` exports `componentsGeneric()`, the stubs `AnyComponents` (DV-174).
  - `api.d.ts` / `api.ts` hold one entry per child instance: `import("<spec>/_generated/component.js")
    .ComponentApi<"<name>">`.
  - The spec is the package name the parent imported, else the child's directory relative to `_generated/`.
    Convex writes `../<definitionPath>` even for a nested local child, which is wrong below the app; bunvex
    computes the relative path from the importing `_generated/` (DV-535, owner 2026-10-19).
- **A local component's `_generated/`** (a `.ts` definition; a published `.js` one is left alone): always `.ts`
  files.
  - Before bundling, the stubs its modules need.
  - After the analysis, `api.ts` with its own children's `components`, and `component.ts`.
  - `component.ts`: `ComponentApi<Name>`, the exports in code-unit order, each a `FunctionReference<type,
    "internal", Args, Returns, Name>` with Convex's `validatorToType` (ids as `string`, `any` without a validator).
  - `server.ts` keeps bunvex's untyped `env` (G4), not Convex's typed one for a component.
- **`FunctionReference`** has Convex's fifth parameter, `ComponentPath = string | undefined`, with
  `_componentPath`.
- **Flags.**
  - `codegen --component-dir <dir>` mounts the component as `exampleComponentInstance` under an app the CLI writes
    to a temporary directory, writes only that component's files and typechecks its directory. A directory without
    a `bunvex.config.ts` is Convex's error.
  - `--live-component-sources` is accepted by `codegen`, `dev` and `deploy` (hidden), adding the
    `"@bunvex/component-source"` condition.
- **`bunvex dev`** also watches each local component's directory outside the functions directory: `deploy`
  returns them, and the watcher adds them.
- **Measured.**
  - `bunvex codegen` on an app with two components spends about 5.7 ms finding and bundling them and 2.6 ms on
    the analysis (10 runs, warm).
  - A push's codegen adds no evaluation, since it reads `start_push`'s answer.
- **Tests.**
  - `cli/test/component-push.test.ts` has 5 more cases:
    - the generated `components` and `component.ts`;
    - a typechecked call: the right arguments pass, wrong ones fail `tsc`, and the reference's `_componentPath`
      is `"counter"`;
    - `bunvex codegen` offline;
    - `--component-dir` and its refusal;
    - `--live-component-sources`.
  - `cli/test/dev.test.ts`: a change in a component outside `bunvex/` is pushed.
  - The goldens now have `componentsGeneric()`.
  - Sabotage: 7 of 7 caught. The seventh, removing `_componentPath`, was missed at first; the typecheck test now
    reads the field.

### As built, PR 3 (`cli/src/run.ts`, `inline-query.ts`, `deploy.ts`, `dev.ts`; `server/src/functions.ts`, `system-functions.ts`)

- **`run --component <path>`** adds `componentPath` to `/api/function`, so the server runs the component's
  function (STUDY-154).
  - A missing function lists the component's functions. `_system/cli/modules:apiSpec` now honours its
    `componentId` argument, as Convex's `queryPrivateSystem` runs it in that component: the component's functions,
    with no HTTP routes until step 7. The CLI resolves the path to the id through
    `_system/frontend/components:list`.
  - `--watch` subscribes with `componentPath`. It now uses the base client, as Convex's `subscribeAndLog`, since
    `onUpdate` takes no component.
  - `--inline-query` resolves the path as Convex's `resolveInlineQueryComponentId`: `_App` or no flag is the app.
    An empty path gets "`--component` must not be empty.", and an unknown one gets "Component path "…" was not
    found." with the mounted components, or "This deployment has no mounted components.". The id goes to
    `run_test_function`.
- **`--typecheck-components`** on `deploy`, `dev` and `run --push`: after the app's typecheck, each local
  component's directory is typechecked in the same mode, and a failure stops the push. `--live-component-sources`
  goes through to `run --push`.
- **Tests.** `component-push.test.ts` has 4 more cases:
  - a component's function, nested included, and the listing for a missing one;
  - `--inline-query` and its two messages;
  - `--watch`;
  - `--typecheck-components`.

  The old refusals are gone from `run-inline-query.test.ts`. Sabotage: 6 of 6 caught.
- **Left for step 9:** `data --component` (DV-224), with the dashboard.

## Divergences

| # | Divergence | Decision |
|---|---|---|
| DV-532 | `bunvex codegen` writes a component's `component.ts` and the app's `components` without a deployment: the CLI evaluates the bundled definitions and reads the functions' validators itself; the file is Convex's | owner, 2026-10-19 |
| DV-533 | Component packages resolve with the conditions `"bunvex"` and, for `--live-component-sources`, `"@bunvex/component-source"` | owner, 2026-10-19 |
| DV-534 | `codegen.legacyComponentApi` is not built: `components` always imports each child's `ComponentApi` | owner, 2026-10-19 |
| DV-535 | A local component's `api.ts` imports a local child's `ComponentApi` by the path relative to its own `_generated/`; Convex writes `../<definition path>`, a module that does not exist below the app (As built, PR 2) | owner, 2026-10-19 |
