# STUDY-153 — Components: the push of component definitions (STUDY-152 step 3)
<!-- index: Components, step 3: the push of component definitions — the request, evaluating each definition, the tree check, per-namespace schemas, `finish_push`'s diffs, the errors, checked against the binary; a four-PR plan | decided (owner, 2026-10-15): DV-494–DV-496; being built -->

- **Status:** decided (owner, 2026-10-15): C-1/C-3/C-4 `bunvex.config.ts` (DV-494), C-7 the server links
  `bunvex/server` into definitions (DV-495), C-5 Convex's texts byte for byte, C-11 a 400 for a malformed
  `_componentDeps` (DV-496); the rest as recommended (§4). Being built in four PRs (§3).
- **Convex source read:** `d8bdde0` of get-convex/convex-backend (paths relative to its root: `crates/…`,
  `npm-packages/convex/src/…`).
- **bunvex source:** `main` after STUDY-152 steps 1–2 (paths relative to `packages/`).
- **Oracle runs** (2026-10-15): the local binary `precompiled-2026-09-28-5c7cb5b` with the `convex@1.46.0` CLI, an
  app with a `counter` component mounted twice. A logging proxy between the CLI and the backend captured every
  deploy2 request and answer (runs `base`, `unmount`, `remount`, `noconfig`), and a small script posted
  hand-written `start_push` bodies straight to the backend (§1.10). The tools are not kept in the repo; §5 says how
  to rebuild them.
- **Related:** [STUDY-152](STUDY-152-components-restudy.md), [STUDY-62](STUDY-62-components.md),
  [STUDY-35](STUDY-35-push-and-deploy.md); DV-429.

---

## 1. Convex's push with components, end to end

### 1.1 Routes and the request

- **Routes.** The routes are `POST /api/deploy2/{start_push, evaluate_push, evaluate_schema, wait_for_schema,
  finish_push, report_push_completed}` (`crates/local_backend/src/router.rs:320-340`).
- **`start_push` handler** (`crates/local_backend/src/deploy_config2.rs:307-331`):
  1. checks the admin key and `DeploymentOp::Deploy`;
  2. runs `req.into_project_config()`. **Any** error there is re-wrapped as 400 **`InvalidConfig`** with the inner
     message and *no* "Hit an error while pushing" prefix (`:318-320`);
  3. runs `Application::start_push`. Its errors get `"Hit an error while pushing:\n"` prepended, with their code
     kept (`:321-324`).
- **`StartPushRequest`** (`crates/application/src/deploy_config.rs:1176-1199`): `{adminKey, functions,
  appDefinition, componentDefinitions[], nodeDependencies, nodeVersion?, dryRun=false, forCodegen=false}`.
  - **`appDefinition`** (`AppDefinitionConfigJson`, `:1450-1462`): `{definition: ModuleJson|null, dependencies:
    string[], schema: ModuleJson|null, changedModules (alias functions), unchangedModuleHashes=[],
    udfServerVersion}`.
  - **`componentDefinitions[i]`** (`ComponentDefinitionConfigJson`, `:1491-1500`): `{definitionPath,
    definition: ModuleJson, dependencies: string[], schema: ModuleJson|null, functions: ModuleJson[],
    udfServerVersion}`.
  - **No unchanged-module hashes for components:** a component always sends every module.
  - **`TryFrom`** (`:1502-1541`):
    - refuses any `"node"` module: `NodeActionsNotSupported`, "Node actions are not supported in components.
      Remove `` `\"use node;\" `` from {path}" (`:1511-1520`). It reaches the client as **`InvalidConfig`** (oracle
      §1.10).
    - parses `definitionPath` and `dependencies` as `ComponentDefinitionPath` (`common/src/components/
      component_definition_path.rs:60-90`): relative, `..` allowed, each segment non-empty, non-control ASCII
      without `/` or `\`, at most 2048 bytes. `/abs` → InvalidConfig "Component paths must be relative (/abs is
      absolute)."
- **What the 1.46 CLI sends** (captured, `base/003-…start_push.req.json` (captured run)):
  - `appDefinition.definition = {path: "convex.config.js", source, sourceMap, environment: "isolate"}`.
    **Always**: with no `convex.config.ts`, the CLI synthesizes `defineApp()` (`noconfig` (captured run);
    `cli/lib/components/definition/directoryStructure.ts:85-122` `isRootWithoutConfig`).
  - `dependencies: ["counter"]`.
  - one `componentDefinitions` entry per **definition** (not per instance: `counter` mounted twice is one entry).
- **How the CLI bundles a definition** (`cli/lib/components/definition/bundle.ts:232, 236-260`):
  - esbuild, `bundle: true`, `platform: "browser"`, `splitting: false`, `minify`, conditions `["convex",
    "module"]`;
  - **`convex/server` is bundled in** (22 KB per config);
  - child definition imports become `import x from "./_componentDeps/<base64url(definitionPath)>"`, external
    (`:209-224`). For example, the app's bundle ends with
    `import $e from"./_componentDeps/Y291bnRlcg";var ce=se();ce.use($e);ce.use($e,{name:"second"})`.
  - The definition path is relative to the app's functions directory, POSIX
    (`directoryStructure.ts:169-183`), e.g. `counter` or `../node_modules/@convex-dev/x/dist/component`.

### 1.2 `start_push`, in order (`deploy_config.rs:198-347`)

1. **`upload_packages`** (`application/src/lib.rs:2335-2486`):
   - The root package is the runtime modules, plus the unchanged modules downloaded from the latest root package
     (`MissingExistingModule` / `ExistingModuleHashConflict` / `ExistingModuleEnvConflict`, all 409), plus
     `schema`, plus `definition` (`AppDefinitionConfig::all_modules`, `model/src/components/types.rs:91-104`).
   - **One package per component definition** is `definition`, `schema` and `functions`
     (`types.rs:130-136`).
   - **One size check over the total** (`lib.rs:2476`).
2. **The app's `UdfConfig`** (`deploy_config.rs:262-268`).
3. **Read the variables** (the user env and the system overrides, `:272-279`). Then:
   - analyze the app's modules and `auth.config` (`:280-312`);
   - **`evaluate_components`** (`:397-540`, §1.3);
   - **`validate_env_var_declarations`** (`:321`, `:1144-1172`);
   - **typecheck and instantiate the tree** (`:325-338`, §1.4).
4. **`start_component_schema_changes`** in one OCC-retried transaction (`:352-381`;
   `model/src/components/config.rs:266-361`, §1.6). A dry run or `forCodegen` runs it too, committed, with the index
   preparation skipped (`skip_index_diff`), then again read-only for the answer's index diffs (`:209-220`); bunvex's
   dry run writes nothing (DV-444).
5. **Fill `exports`** for every non-root definition with `file_based_exports(functions)` (`:225-235`;
   `model/src/components/file_based_routing.rs:24-77`). Only public functions are exported, each as a leaf
   `"_reference/function/<module>.js:<name>"`. A clash between two exports is `InvalidExport`.
6. **Answer `StartPushResponse`** (`:1236-1252`), serialized by `SerializedStartPushResponse`
   (`deploy_config2.rs:90-188`):

```
{ environmentVariables: {name: value},             // the variables read in step 3, echoed to finish_push
  externalDepsId, componentDefinitionPackages: {definitionPath: SourcePackage-as-ConvexObject-JSON},
  appAuth: [...],
  analysis: {definitionPath: {definition: SerializedComponentDefinitionMetadata, schema|null,
                              functions: {module: SerializedAnalyzedModule}, udfConfig}},
  app: SerializedCheckedComponent,                  // the instantiated tree
  schemaChange: {allocatedComponentIds: {componentPath: id}, schemaIds: {componentPath: id|null},
                 indexDiffs: {componentPath: SerializedIndexDiff}} }
```

- The root's key is `""` everywhere. The captured answer is `base/003-…start_push.res.json` (captured run).
- **`allocatedComponentIds` holds `""` too** on a deployment's first push: the root's `_components` id is
  allocated there and no tables are made (`config.rs:364-383`).
- `schemaIds[path]` is null when a component has no schema (`config.rs:313-344`).
- `evaluate_push` (`deploy_config.rs:561-576`) is the same evaluation, followed by the read-only schema change.

### 1.3 Evaluating `convex.config.js`

**Who evaluates what.** `evaluate_components` (`deploy_config.rs:397-540`) works in four steps:

1. **It evaluates the app schema.**
2. **It analyzes each component definition's `functions` with its own `UdfConfig`:**
   - the definition's `udfServerVersion`;
   - **the root's** `importPhaseRngSeed` and `importPhaseUnixTimestamp`, so every namespace's `_udf_config` row
     carries the same seed (`:415-428`, checked in the fixture);
   - **no user variables**: "User env vars are root-only" (`:429-441`).
3. **It evaluates each component's schema.** A JS error there is `InvalidSchema` (`:443-455`).
4. **It evaluates the definitions:**
   - if `appDefinition.definition` is present, it builds the dependency graph from the root's and each
     definition's `dependencies` (`:465-480`) and runs `evaluate_app_definitions` (`:482-500`);
   - a **`JsError`** becomes 400 **`InvalidConvexConfig`** with the JS message (`:492-498`). Any other error
     (`CyclicImport`, `InvalidDefinition`, …) passes through with its own code: the `downcast` fails and `?`
     re-raises it;
   - **no definition** gives `ComponentDefinitionMetadata::default_root()` (`:501-506`;
     `common/src/bootstrap_model/components/definition.rs:53-64`).

**The evaluator** (`crates/isolate/src/environment/component_definitions.rs`):

- **Order and cycles.**
  - A post-order DFS from the root over the dependency graph (`:119-193`).
  - Re-entering a path still in progress is **`CyclicImport`**, "Found cyclic definition dependency"
    (`:138-143`).
  - Each definition is evaluated after its dependencies, in a **fresh V8 context** (`:195-226`).
- **The module.**
  - The module is `convex:/convex.config.js`, the same name for the app and for components (`:482-483`).
  - The only imports that resolve:
    - the module itself;
    - `_componentDeps/<base64url>` (`:561-608`).
  - That import is answered with a **synthetic module**:
    `export default { export: () => <SerializedComponentDefinitionMetadata of the already-evaluated child>,
    componentDefinitionPath: "<path>", defaultName: "<definitionType.name>" }` (`:589-597`).
  - Its edge cases:

    | Import | Result |
    |---|---|
    | A path that does not decode | `InvalidModule` |
    | A definition not evaluated | `None` → 500, oracle |
    | The app itself | `NoImportAppDuringDefinitionEvaluation` |
    | Anything else | **`NoImportModuleDuringDefinitionEvaluation`**, "Can't import {path} while evaluating app definition" (`:604-607`) |
- **Globals** (`DefinitionEnvironment`, `:485-558`):
  - `console.*` is accepted and dropped: only a server-side warning (`:496-502`).
  - These are refused:

    | Call | Code | Message |
    |---|---|---|
    | `Math.random` | `NoRandomDuringDefinitionEvaluation` | "Math.random unsupported when evaluating app definition" |
    | crypto | `NoCryptoRngDuringDefinitionEvaluation` | |
    | `Date` | `NoDateDuringDefinitionEvaluation` | "Date unsupported when evaluating app definition" |
    | `performance` | `NoPerformanceDuringDefinitionEvaluation` | |
    | any syscall | `NoSyscallDuringAppDefinitionEvaluation` | |
    | async syscalls and ops (fetch, …) | `No…DuringAppDefinition` | |
  - **`process.env` works in the app's config only**, with the user variables and the system ones (`:205-211`). In
    a component's config it is **`EnvironmentVariablesUnsupported`**, with a docs.convex.dev link (`:539-550`).
  - Each refusal is thrown into JS, so it surfaces as `InvalidConvexConfig`, "Uncaught Error: Date unsupported
    when evaluating app definition\n    at … (convex.config.ts:5:15)", source-mapped (oracle).
  - **Top-level await** gives InvalidConvexConfig, "Top-level awaits in source files are unsupported".
- **The default export checks** (`:232-305`):
  - a missing default export → `InvalidDefinition`;
  - more than one export → "`convex.config.ts` has more than one export";
  - no `export` property;
  - `export` not a function;
  - `export()` not returning an object.

  Each is `invalid_export_value` (`:316-337`), whose message differs for the app and for components and names
  `defineApp()` / `defineComponent()` with `import … from 'convex/server'`.
- **Reading the result.**
  - The server calls `export()` and **injects `path`** (`:280-292`).
  - It deserializes the result as `SerializedComponentDefinitionMetadata`. A failure is `InvalidDefinition`,
    "Failed to deserialize {json}: {serde error}", e.g. "missing field `childComponents`" (`:294-303`).
  - It then runs `TryFrom`, where a failure is `InvalidDefinition` with the error text: "Identifier my-comp has
    invalid character '-': …", "Identifier cannot be empty", "Condition failed: `s.starts_with('/')`" (`:304-305`).
- **Legacy.** `ComponentInitializerEvaluator` (`:339-480`) runs `_onInitCallbacks` for instantiations with
  `args: null`, which no 1.46 package produces (`args` is always `[]`). Not needed.

### 1.4 What `defineApp` / `defineComponent` / `app.use` produce (npm side)

The file is `npm-packages/convex/src/server/components/index.ts`.

- **`defineComponent(name, {env?})`** (`:674-712`):
  - Each env value must pass `isValidator`, else "Environment variable "X" must be defined with a validator
    (e.g. v.string())."
  - It returns `{_isRoot:false, _name, _env, _childComponents:[], _exportTree:{}, _onInitCallbacks:{}, env:
    EnvRefs, export: exportComponentForAnalysis, use}`.
- **`defineApp({httpPrefix?, env?})`** (`:737-770`):
  - an `httpPrefix` must start with `/`;
  - it checks the env validators the same way;
  - it returns `{_isRoot:true, _childComponents, _exportTree, _httpPrefix?, _env?, env, export:
    exportAppForAnalysis, use}`.
- **`env` references** (`:386-404`): a Proxy. `app.env.X` is `{__envVarRef:"X"}`. An undeclared name throws
  "Env var "X" is not declared on this app. Add it to the `env` option of defineApp."
- **`use(def, {name?, httpPrefix?, env?})`** (`:414-474`):
  - `def` must carry `componentDefinitionPath`: the synthetic import does, else "…This code only works in Convex
    runtime.";
  - the name defaults to `def.defaultName`, then to the last segment of the path;
  - an empty name throws "Component name cannot be empty.";
  - an `httpPrefix` must start with `/`;
  - `undefined` env values are dropped;
  - it pushes `[name, def, env, httpPrefix]` and returns an `InstalledComponent`, whose reference path is
    `_reference/childComponent/<name>` (`:344-364`; `paths.ts:3-10`).
- **`export()` of the app** (`exportAppForAnalysis`, `:490-521`):

```
{ definitionType: {type:"app"}, httpPrefix?: "/p/"            // normalized to end with "/" (:537-540)
  childComponents: [{name, path: componentDefinitionPath, args: [], env: [[k, {type:"value",value}|{type:"envVar",name}]]}],
  httpMounts: {"/prefix/": "_reference/childComponent/<name>"}, // (:542-558)
  exports: {type:"branch", branch: []},                         // _exportTree is never filled
  envVars?: [[name, {type:"value", value: JSON.stringify(validator.json), optional?: true}]] }
```

- **`export()` of a component** (`exportComponentForAnalysis`, `:614-645`) is the same, plus `name` and
  `definitionType: {type:"childComponent", name, args: []}`. It has no `httpPrefix`, and `envVars` appears only
  if non-empty.
- **Env serialization.** An env value must be a string or an env reference, else "Env var "X" must be a string or
  an env var reference. Received: number" (`:578-596`). Types are in `components/definition.ts:43-60`.
- **`componentsGeneric()`** (`:790-815`) is a Proxy whose `[Symbol.for("toReferencePath")]` is
  `_reference/childComponent/<a>/<b>/…`. With fewer than one segment after the root, it throws "API path is
  expected to be of the form `components.childComponent.functionName`. Found: `components`".
- **`currentSystemUdfInComponent(id)`** (`:782-788`) is `_reference/currentSystemUdfInComponent/<id>`, used by
  the dashboard (step 9).
- **`getFunctionAddress`** (`paths.ts:20-48`) maps a reference to one of three forms:
  - `{functionHandle}` for a `function://` string;
  - `{name}` for a path or `functionName` reference;
  - `{reference}` for a `toReferencePath` reference.
- **`createFunctionHandle`** (`index.ts:65-79`) sends `{...address, version}` to `1.0/createFunctionHandle`.
- **The server reads only the `export` function** and `componentDefinitionPath` / `defaultName` (on imported
  children). Shown on the binary: a **hand-written** `export default { export: () => ({...}) }` with no `convex`
  code pushes fine (`sp.ts handwritten` → 200).

### 1.5 The definition tree check and instantiation (`model/src/components/type_checking.rs`)

- **`instantiate_root`** (`:113-132`) starts from definition `""`, path `""`, no args, no env, and the
  definition's `httpPrefix`.
- **`instantiate`** (`:134-287`), per node:
  1. **`check_args`** (`:426-482`):
     - an App with args → "Can't have arguments for the root app";
     - every env key must be declared: "Component {path:?} has no env var named {name:?}";
     - for a child, unless `forCodegen`, every non-optional declared var must be bound: "Component {path:?} is
       missing required env var {name:?}".
  2. **Per child instantiation, in order:**
     - its definition must exist: `TypecheckError` "Component definition not found: {path:?}" (`:209-217`);
     - **`validate_component_env`** (`:331-403`):
       - a value binding must pass the child's validator ("…has an invalid value for env var …: `"b"` does not
         match literal validator `v.literal("a")`.");
       - an `envVar` binding must name a parent-declared var ("…references undeclared parent env var APPX");
       - a required child var cannot take an optional parent var ("…is required, but parent env var APPX is
         optional");
       - the parent's validator must be a subset of the child's;
     - **chain resolution** (`:225-245`):
       - at the root, an `envVar` binding stays `{type:"envVar", name}`, a deployment variable;
       - below the root, it is replaced by the parent's own resolved binding, or **dropped** if the parent has
         none (an optional, unbound var);
       - oracle `nested`: `inner.Y ← counter.X ← APPX` gives inner `{Y: envVar APPX}`;
     - **the child's `httpPrefix`** is its mount path, composed with the parent's prefix below the root
       (`:247-265`);
     - **duplicate names** → "Component {definitionPath:?} has multiple child components with the same name:
       {name:?}" (`:484-500`).
  3. **HTTP mounts** (`:502-554, :701-724`):
     - the reference must be a direct child with no attributes;
     - the child must have HTTP routes: "HTTP mount {path:?} is invalid: Child component {name:?} doesn't have
       any HTTP routes.";
     - no overlap with the parent's own `http.js` routes or other mounts.
  4. **`build_exports`** (`:556-652`) resolves `file_based_exports` into `ResourceTree` leaves
     `{type:"function", path:{component, udfPath}}`.
- **The messages use Rust's `Debug` formatting**, e.g. `Component [ComponentName(Identifier("counter"))] is
  missing required env var Identifier("X")`, `ComponentDefinitionPath { path: "" }`, `HttpMountPath("/c/")`.
  `:149` even prints the literal `{definition_path:?}`: the string is missing `format!`.
- **`SerializedCheckedComponent`** (`:755-768, :836-891`) is `{definitionPath, componentPath, httpPrefix|null,
  args:{}, env:{name:{type,…}}, childComponents:{name: …}, httpRoutes:{httpModuleRoutes|null, mounts:[]},
  exports:{name: {type:"branch",children}|{type:"leaf",resource}}}`. `childComponents` is a **map**.

### 1.6 Per-component schemas and the index/table plan per namespace

`start_component_schema_changes` (`config.rs:266-361`) walks the existing `_components` tree and the new tree
together, with `tree_diff_children` (`:832-878`) visiting existing children first and then new ones. Per node:

| Case | What happens |
|---|---|
| **New** | `initialize_component_namespace` (`:364-415`): an id from the global `_components` table, and that namespace's 12 system tables (a no-op for the root) |
| **Existing** | Its id |
| **Removed** (existing, not new) | Nothing is planned: "Leaving existing schema and tables in place for deleted component" (`:346-348`); its children are still visited |

Then, for a node that is new or kept, in its namespace:

- with a schema: `IndexModel::prepare_new_and_mutated_indexes`, recorded in `indexDiffs[path]`, then
  `SchemaModel::submit_pending`, recorded in `schemaIds[path]` (`:313-332`);
- without one: the index diff against no indexes, and `schemaIds[path] = null` (`:333-343`).

**Allocations are committed by `start_push`.** An abandoned push leaves an allocated namespace (its tables)
with no `_components` row. The oracle `mismatchedDefName` allocated a namespace for `zzz` that no finish ever
used.

**`wait_for_schema`** (`deploy_config.rs:709-828`) checks every path in `schemaIds`:

- `failed` carries `componentPath`;
- `overwritten` is `raceDetected`;
- index progress is counted per namespace;
- a component that exists under another id than the allocated one is 409 **`RaceDetected`**, "Component {path}
  was created by a concurrent push" (d8bdde0 `:783-789`; the same id is fine); neither existing nor allocated is a
  system error, "Invalid existing component state".

**`evaluate_schema`** (`:584-689`) answers `componentSchemaEvaluations` keyed by component path, the root always
included, and `newComponentDefinitions`: pushed definitions with no instance yet. Unmounted instances whose
definition is gone are skipped.

### 1.7 `finish_push` (`deploy_config.rs:830-986`)

**The request** is `FinishPushRequest {adminKey, startPush: <the echoed start_push answer>, dryRun, message?}`
(`deploy_config2.rs:412-418`). A dry run answers an empty diff (`:437-443`). Otherwise:

1. **Download every package** (`:838-843`) and strip `exports` from the analysis (`:845-850`). Then, in **one**
   transaction with audit events and OCC retries (`:854-965`):
2. **The variables check.** The variables must still equal `startPush.environmentVariables`, else 400
   `RaceDetected`, "Environment variables have changed during push" (`:863-873`).
3. **The app's required variables** must be set, else 400 **`MissingEnvironmentVariables`**, "Required
   environment variables are not set: APPX. Set them in the Convex dashboard or CLI before pushing." (`:875-899`;
   oracle). Then `validate_env_var_values` (`application/src/lib.rs:575-598`): a set value failing its declared
   validator is 400 `InvalidEnvironmentVariable`, "Environment variable {name} does not match its declared
   validator: {e}".
4. **`AuthInfoModel::put`** (`:907-910`).
5. **`apply_component_definitions_diff`** (`config.rs:103-194`):
   - a definition path no longer pushed has its `_component_definitions` row **deleted**. Unmounted instances
     keep pointing at the gone id: checked on the binary;
   - each pushed definition is replaced if its path exists, else inserted;
   - every module of its package becomes a module to write, **including `convex.config.js` and `schema.js`**,
     each with `AnalyzedModule::default()` when it defines no function (`:150-160`);
   - `definitionDiffs[path] = {}` for each, deleted ones included.
6. **`apply_component_tree_diff`** (`config.rs:437-552`), per node:

   | Case | Result |
   |---|---|
   | **create** (`:555-618`) | The `_components` row is inserted **with the allocated id**; then in its namespace: `_udf_config` set (diff from "Unspecified version"), the `_source_packages` row, `_modules` (`ModuleModel::apply`), crons (`CronModel::apply`), function handles (`FunctionHandlesModel::apply_config_diff`, global table, component field), the schema applied (`SchemaModel::apply`), its indexes committed (`IndexModel::apply`), and the index diff from `get_full_index_diff`. Diff type `create` |
   | **modify** (`:621-692`) | The row is replaced, then the same writes |
   | **remount** | A modify whose existing row was `unmounted` |
   | **RaceDetected** (409, d8bdde0 `:509-516`) | An existing node whose allocated id differs: "Component {path} was created by a concurrent push" |
   | **unmount** (`:694-729`) | An existing node not in the new tree: the row is set to `state: "unmounted"`; modules, crons and handles are cleared; the schema, tables, data, `_udf_config` and `_source_packages` stay. `index_diff` is empty, and `udf_config_diff` and `schema_diff` are null. Its children are then unmounted too |
   | An already unmounted node | Skipped and **not** recursed (`:529-533`) |

   A child's row is `{definitionId, parent, name, args: [], env: [[k, binding]], state, httpPrefix}`. The root's
   row has `args`, `env`, `parent` and `name` null (`:462-487`).
7. **The audit event.** One `DeploymentAuditLogEvent::PushConfigWithComponents { diffs }` (`:952-957`) is
   serialized as `{auth_diff, component_diffs: [{component_path: null | "a/b", component_diff:
   SerializedComponentDiff}], message, node_version_diff}`, ordered by path, root first
   (`model/src/deployment_audit_log/types.rs:1209-1328`).
   - `SerializedComponentDiff` (`config.rs:912-950`) is `{diffType: {type: "create"|"modify"|"unmount"|
     "remount"}, moduleDiff: {added, removed}, udfConfigDiff, cronDiff, indexDiff, schemaDiff:
     {previous_schema, next_schema}|null}`.
   - Captured rows are in the binary's `_deployment_audit_log` (§1.10).
8. **An OCC failure of `finish_push`** after the retries is `ConcurrentPush`, "Are you running multiple `npx
   convex dev` processes in the same directory?" (`:966-982`).
9. **The answer** is `SerializedFinishPushDiff {authDiff, definitionDiffs: {path: {}}, componentDiffs: {path:
   SerializedComponentDiff}}` (`deploy_config2.rs:498-524`). It **includes `schemaDiff`** when the schema
   changed (oracle).

### 1.8 Per-namespace rows (the fixture and the oracle agree)

- **`_component_definitions`** (global, `SerializedComponentDefinitionMetadata`,
  `common/src/bootstrap_model/components/definition.rs:183-323`): `{path, definitionType: {type:"app"} |
  {type:"childComponent", name, args: []}, childComponents: [{type:"SerializedComponentInstantiation", name,
  path, args: [], env: []}], httpMounts: {}, httpPrefix: null, exports: {type:"branch", branch: []}, envVars:
  null | [[name, {type:"value", value: "<validator json>", optional?: true}]]}`.
  - The **`"type":"SerializedComponentInstantiation"`** field is stored and answered. It comes from serde's
    `tag` on a struct (`:235-243`), and both the fixture and the oracle show it.
  - `envVars` is `null` when empty (`:260-269`).
  - `exports` is always stored empty (`load_all_definitions` clears it, `database/src/bootstrap_model/
    components/mod.rs:346-370`).
- **`_components`:** as STUDY-152 §11.
- **Per namespace:**
  - `_modules`: **`convex.config.js`**, `schema.js` and the functions, all sharing the namespace's
    `sourcePackageId`;
  - `_source_packages`: one per namespace. **Two instances of one definition share the same `storageKey` and
    `sha256`**, with distinct rows (fixture);
  - `_udf_config`: the root's seed and timestamp, the definition's version;
  - `_schemas`, `_cron_*`, `_scheduled_*` and `_file_storage` in the namespace.

### 1.9 Everything a component push can answer (codes)

| Code | Status | Where |
|---|---|---|
| `InvalidConfig` (wraps parse errors, incl. NodeActionsNotSupported, bad paths) | 400 | deploy_config2.rs:318 |
| `CyclicImport` | 400 | component_definitions.rs:139 |
| `InvalidConvexConfig` (JS exceptions in a config) | 400 | deploy_config.rs:496 |
| `InvalidDefinition` (export shape, deserialize, identifiers, mounts) | 400 | component_definitions.rs:239-305, 316 |
| `NoImportModuleDuringDefinitionEvaluation` / `NoImportAppDuringDefinitionEvaluation` / `InvalidModule` | 400 | :582-607 |
| `No{Random,CryptoRng,Date,Performance}DuringDefinitionEvaluation`, `EnvironmentVariablesUnsupported` (as InvalidConvexConfig when thrown in JS) | 400 | :504-550 |
| `InvalidEnvVarDeclaration` | 400 | deploy_config.rs:1144-1172 |
| `TypecheckError` (§1.5) | 400 | type_checking.rs |
| `InvalidExport` | 400 | file_based_routing.rs:50, 66 |
| `InvalidSchema` (component schema) | 400 | deploy_config.rs:452 |
| `RaceDetected` (env changed; concurrent component creation) | 400 / 409 | deploy_config.rs:870, 783-789; config.rs:509-516 (d8bdde0) |
| `MissingEnvironmentVariables`, `InvalidEnvironmentVariable` | 400 | deploy_config.rs:892; lib.rs:588 |
| `MissingSourcePackage` | 400 | config.rs:136-141 |
| `ConcurrentPush` | 400 | deploy_config.rs:975 |
| `ComponentMustBeUnmounted`, `ComponentNotFound` (delete_component) | 400 / 404 | config.rs:731-786 |
| 500 InternalServerError: unknown `_componentDeps` target, a dependency with no definition, deps without `componentDefinitions` | 500 | oracle |

### 1.10 Oracle results (binary, 2026-10-15)

| Case (`sp.ts …` or CLI) | Answer |
|---|---|
| base CLI push, `counter` twice | 200; `allocatedComponentIds {"":…, counter, second}`; `definitionDiffs {"":{}, counter:{}}`; three `create` diffs; module diff `[app.js, convex.config.js, schema.js]` / `[convex.config.js, lib.js, schema.js]` |
| `handwritten` (plain-object configs) | 200 |
| `cyclic`, `cyclic2` | 400 CyclicImport "Hit an error while pushing:\nFound cyclic definition dependency" |
| `throws` | 400 InvalidConvexConfig "…Uncaught Error: boom in config\n    at <anonymous> (convex.config.ts:5:15)\n" |
| `noDefault` / `twoExports` / `noExportProp` / `exportNotFn` / `exportNotObj` | 400 InvalidDefinition, Convex's five `invalid_export_value` texts |
| `badShape` | 400 InvalidDefinition "Failed to deserialize {\"definitionType\":{\"type\":\"app\"},\"path\":\"\"}: missing field `childComponents`" |
| `date` / `random` | 400 InvalidConvexConfig "Uncaught Error: Date unsupported when evaluating app definition …" |
| `fetchIt` (top-level await) | 400 InvalidConvexConfig "Top-level awaits in source files are unsupported\n" |
| `importOther` | 400 NoImportModuleDuringDefinitionEvaluation "convex:/convex.config.js:0:14: Can't import other.js while evaluating app definition" |
| `envInComponent` | 400 InvalidConvexConfig "Uncaught Error: Environment variables are only supported in the app's convex.config.ts. Learn more at https://docs.convex.dev/…" |
| `envInApp`, `console` | 200 |
| `importApp`, `unknownDep`, `missingDefForDep`, `noComponentDefs` | **500** InternalServerError |
| `node` | 400 **InvalidConfig** "Node actions are not supported in components. Remove `\"use node;\" from lib.js" (no prefix) |
| `envNumber` / `appEnvNumber` | 400 InvalidEnvVarDeclaration "Env var `X` on component counter has a non-string validator. …" / "… on the app …" |
| `missingReqEnv`, `undeclaredEnv`, `badLiteral`, `envRefUndeclared`, `envRefOk` (optional→required) | 400 TypecheckError, Debug-formatted (§1.5) |
| `envRefOk2`, `nested` | 200; env chain resolved to `{type:"envVar", name:"APPX"}` two levels down |
| `dupName` | 400 TypecheckError "Component ComponentDefinitionPath { path: \"\" } has multiple child components with the same name: ComponentName(Identifier(\"counter\"))" |
| `badName` / `emptyName` | 400 InvalidDefinition "Identifier my-comp has invalid character '-': Identifiers can only contain alphanumeric characters or underscores" / "Identifier cannot be empty" |
| `unknownPath` | 400 TypecheckError "Component definition not found: ComponentDefinitionPath { path: \"nope\" }" |
| `httpMountNoRoutes` | 400 TypecheckError "HTTP mount HttpMountPath(\"/c/\") is invalid: Child component … doesn't have any HTTP routes." |
| `httpPrefixBad` | 400 InvalidDefinition "Condition failed: `s.starts_with('/')`" |
| `absPath` | 400 InvalidConfig "Component paths must be relative (/abs is absolute)." |
| `badSchema` | 400 InvalidSchema "…Uncaught Error: bad schema\n    at <anonymous> (convex:/schema.js:1:7)\n" |
| CLI: remove `second` | `second` → `{type:"unmount"}`, `moduleDiff.removed [convex.config.js, lib.js, schema.js]`; row `state:"unmounted"`; `schemaIds`/`indexDiffs` only `""` and `counter` |
| CLI: add it back | `second` → `{type:"remount"}`, modules re-added, `udfConfigDiff: null`, `schemaDiff: null` |
| CLI: `defineApp({env:{APPX: v.string()}})`, APPX unset | finish_push 400 MissingEnvironmentVariables |
| CLI: no `convex.config.ts` and no `counter/` | Synthetic app definition sent; `counter` and `second` → unmount; the `counter` definition row deleted while both instances still name it |
| audit rows | `component_diffs` `[{component_path:null,…},{component_path:"counter",…},{component_path:"second",…}]` with `diffType` as in the answer |

---

## 2. What bunvex has today, and what has to change

### 2.1 `server/src/push.ts`

**Today:**

- **The refusals.** `evaluateSchema` (`:366-390`) and `startPush` (`:409-489`) refuse any `componentDefinitions`
  with `ComponentsNotSupported` (`:368-369`, `:412-413`).
- **`StartPushRequest`** (`:153-167`) ignores `appDefinition.definition` and `dependencies`.
- **`response()`** (`:491-518`) answers a fixed root:
  - `analysis[""].definition` is **null** (Convex's is the metadata);
  - `udfConfig` is null;
  - `app` is `{definitionPath, componentPath, args: {}, childComponents: []}`, where Convex's has `httpPrefix`,
    `env`, `httpRoutes`, `exports` and a map of children: a latent wire mismatch;
  - `componentDefinitionPackages` is `{}`;
  - `allocatedComponentIds` is `{}`.
- **`waitForSchema`** (`:521-542`) looks at `schemaIds[""]` only.
- **`finishPush`** (`:545-649`):
  - finds the pending push by `schemaIds[""]`;
  - writes the root code with `writeCodeRows` and the crons with `cronExecutor.applyIn(db, specs)`;
  - writes one audit event for the root;
  - answers with `diff()` (`:651-672`), whose `schemaDiff` is always null and which has no `definitionDiffs`.

**To change:**

1. **The request.** Type `StartPushRequest.appDefinition.{definition, dependencies}` and
   `componentDefinitions: ComponentDefinitionConfig[]`, with Convex's `TryFrom`:
   - module paths;
   - `ComponentDefinitionPath` parsing, rejected as `InvalidConfig` with Convex's texts;
   - Node modules in a component → `InvalidConfig` "Node actions are not supported in components. Remove
     `\"use node;\" from {path}".

   Remove the two refusals.
2. **`startPush`**, in Convex's order:
   1. external deps and the package-size check over **all** packages (root plus one per definition, `buildPackage`
      each, the sizes summed);
   2. resolve the root modules;
   3. the root `udfConfig`;
   4. the env;
   5. analyze the root (existing);
   6. **evaluate components**:
      - per definition, `CodeVersion.load(functions, {seed/timestamp of the root, env: {}})`, with no user
        variables;
      - each component's schema → `InvalidSchema`;
      - the definitions (§2.3) → `CyclicImport` / `InvalidConvexConfig` / `InvalidDefinition` / …;
   7. **`validateEnvVarDeclarations`**;
   8. **typecheck and instantiate** (a new `component-tree.ts`, porting §1.5 with its messages);
   9. **start the schema per namespace**: walk the existing and new trees as `start_component_schema_changes`
      does, reserving new namespaces with `engine.initializeComponentNamespace()` (built in step 2) and starting
      each namespace's schema (§2.6). The root keeps the existing path;
   10. fill the non-root `exports`;
   11. answer the full `SerializedStartPushResponse`.
3. **The pending push.** `Pending` (`:214-231`) becomes per push, not per root schema:
   - per definition path: `CodeVersion`, modules, schema module, definition module, package, udf config diff;
   - per component path: schema id and namespace id;
   - the checked tree;
   - the env values (for `MissingEnvironmentVariables`).

   Key it by a push id the response carries (still `schemaIds[""]`, or the root's allocated id when the root has
   no schema).
4. **`waitForSchema`** iterates every `schemaIds` path. `failed` carries `componentPath`, `inProgress` carries
   per-path progress, and a race on a concurrently created component is 409 `RaceDetected` (Convex's text).
5. **`finishPush`**, in one engine commit:
   1. the env check (existing);
   2. **`MissingEnvironmentVariables`** and **`InvalidEnvironmentVariable`** against the app's `envVars`;
   3. the auth (existing);
   4. **the definitions diff** (`_component_definitions`);
   5. **the tree diff** (create / modify / remount / unmount, with per-namespace `_udf_config`,
      `_source_packages`, `_modules`, crons, schema and indexes; §2.2);
   6. the audit event with every path;
   7. the answer `{authDiff, definitionDiffs, componentDiffs}`, where every diff carries Convex's `schemaDiff`
      (today null: fix it for the root too).

   After the commit, install the root version as today. Component versions are only stored: nothing runs in a
   component until step 4.
6. **`evaluateSchema`** (`:366-390`) answers one `componentSchemaEvaluations` entry per **instance** path
   (existing instances, unmounted ones with a live definition included) and the `newComponentDefinitions`.

### 2.2 `server/src/code-store.ts`

- **`ensureRootComponent`** (`:328-355`) writes a constant root definition, once. Replace it with the
  definitions diff and the tree diff:
  - the root's `_component_definitions` row becomes the **evaluated** app definition: `childComponents`,
    `httpMounts`, `httpPrefix`, `envVars`, and `exports` stored empty;
  - the root's `_components` row is inserted with the allocated id on a first push, or replaced on later ones.

  Add `componentDefinitionRow` / `componentDefinitionMeta` beside `componentRow` / `componentMeta`
  (`core/src/components.ts:42-80`), writing `type: "SerializedComponentInstantiation"` in each child entry and
  `envVars: null` when empty. Round-trip the fixture's rows.
- **`writeCodeRows`** (`:357-396`) must take a namespace (the component id, or the root) and run against that
  namespace's `_modules` and `_source_packages`:
  - **source-package GC per namespace.** Today it deletes every other `_source_packages` row and returns their
    blobs as unused; with namespaces it must only see its own namespace;
  - **a blob is deleted only when no namespace references its `storageKey`**: two instances share one package,
    as Convex's do;
  - **unmount** = delete the namespace's `_modules` rows (and crons and handles), keeping `_source_packages` and
    `_udf_config`.
- **`udfConfig`** (`:263-298`) needs a per-namespace variant. It writes the root's seed and timestamp with the
  definition's `serverVersion`, and diffs from "Unspecified version" on create.
- **`storedModules` / `loadLatestCode`** (`:398-451`) stay root-only for step 3, with one fix. `loadLatestCode`
  filters only `auth.config.js` and `schema.js` (`:447`). Once the root package holds the **definition module**,
  `loadLatestCode` must not load it as a function module, for two reasons:
  - it imports `./_componentDeps/…`, which `CodeVersion`'s linker refuses ("Could not resolve");
  - **a store the Convex binary wrote with components already has `convex.config.js` in its root package**, so
    this is a latent failure as soon as such a package is readable.

  The fix:
  - name the module by its role (rule 5 forbids the literal);
  - skip a root-level module whose basename has more than one dot. Convex's entry-point rule never makes one a
    function module, which also covers `auth.config.js`;
  - or skip modules whose stored analysis is empty and which import `_componentDeps`.

  §4 C-2 has the recommendation.

### 2.3 `server/src/code-version.ts`

Add a **definition evaluator** (a new file, e.g. `component-definitions.ts`) alongside `CodeVersion.load`
(`:298-433`):

- **Evaluation.** One `vm.SourceTextModule` per definition, each in a **fresh context**. Evaluate in post-order
  from the root over `dependencies`, with the in-progress set giving `CyclicImport`.
- **Globals** (Convex's §1.3):
  - `Date`, `Math.random`, crypto, `performance`, `fetch` and the bunvex syscalls throw Convex's errors;
  - `process.env` reads the env in the app's config only and throws `EnvironmentVariablesUnsupported` in a
    component's;
  - `console.*` is a no-op;
  - top-level await gives `InvalidConvexConfig` "Top-level awaits in source files are unsupported".

  The existing helpers can be reused: `contextGlobals` / `installDeterminismIn` (`:316-333`); `onMissingEnv`
  already shows a per-read hook.
- **The linker** resolves:
  - `./_componentDeps/<b64url>` to a `vm.SyntheticModule` with `default = {export: () => <serialized child>,
    componentDefinitionPath, defaultName}`;
  - `bunvex/server` and `bunvex/values` to the server's own modules, *if* the bunvex CLI leaves them external
    (§4 C-7; `SERVER_MODULES`, `:134-140`);
  - anything else: `NoImportModuleDuringDefinitionEvaluation`.
- **Its import checks.** An undecodable path is `InvalidModule`; an unknown definition is the 500, or a 400 by
  C-11; the app itself is `NoImportAppDuringDefinitionEvaluation`.
- **The default export** is checked as §1.3 (five `InvalidDefinition` texts). Then call `export()`, set `path`,
  and validate the result against `SerializedComponentDefinitionMetadata`:
  - required `definitionType`, `childComponents`, `exports`;
  - `httpMounts` optional (default `{}`);
  - `envVars` optional;
  - identifiers checked, mount paths checked (`HttpMountPath::from_str`, `definition.rs:102-113`), env
    validators JSON-parsed.

  A failure is `InvalidDefinition` with Convex's texts.
- **JS exceptions** become `InvalidConvexConfig`, under bunvex's code name (C-3), with the source-mapped frame:
  `describeUncaught` and `stack-map.ts` already do it for modules.
- **Component function modules** load with `CodeVersion.load` per **definition**, with no user env. C3 (one
  context per component instance) is step 4's runtime concern; at push, analysis per definition is what Convex
  does.

### 2.4 `server/src/push-audit.ts` and `audit-log.ts`

- **`indexAuditDiff` / `indexDiffJson`** (`push-audit.ts:53-91`) work on two `SchemaDefinition`s. They are reused
  per namespace with that namespace's active schema: the engine knows only `engine.schema`, the root's, so it
  needs a per-namespace active schema (§2.6).
- **`auditEvents.pushConfigWithComponents`** (`audit-log.ts:49-78`) hard-codes one root entry
  (`component_path: null`, `diffType` create|modify). It must take the list of `{componentPath, diff}` sorted by
  path, with `unmount` / `remount` types. An unmount entry has `udfConfigDiff: null`, an empty index diff and
  `schemaDiff: null`.

### 2.5 The CLI side (step 6): what the server must accept

The server must accept exactly Convex's request shape (§1.1):

- `appDefinition.definition` is a module named `<config>.js` (C-1) or null;
- `appDefinition.dependencies` and each `componentDefinitions[i].dependencies` are definition paths;
- child imports in definition sources are `./_componentDeps/<base64url(definitionPath)>`;
- `functions` holds no `"use node"` module;
- `udfServerVersion` comes per definition.

`cli/src/deploy.ts:542-550` today sends `definition: null, dependencies: [], componentDefinitions: []`;
`cli/src/bundle.ts` excludes multi-dot names and keeps `bunvex/*` external (`:10, :35, :131-144`). Server PRs
can be tested with hand-written requests (§3), as the oracle's `sp.ts handwritten` shows.

### 2.6 What `core` must provide (the enabling work)

- **A namespaced transaction view.** The `Tx` resolves table names through `this.catalog`, the root's
  (`core/src/tx.ts:681-691, 976, 1159`). Step 1 keeps each component's tables in `catalog.components.get(id)`.
  - Add `db.inComponent(id)`: the same read and write sets, the catalog swapped, so `query`, `insert`, `get`
    and `newId` address that namespace (ids encode the namespace's table numbers).
  - Every per-namespace write (`_modules`, `_source_packages`, `_udf_config`, `_schemas`, crons) needs it.
- **Per-namespace schema pushes.** `Engine.startSchemaPush` / `commitSchemaPush` / `schemaPushStatus`
  (`core/src/engine.ts:2760-2960`) and `finishCatalog` (`catalog.ts:851-873`, which uses
  `activeTables(tables)`, the root's) are single-namespace and keep `this.schema` / `this.pendingPush`.
  - They need a namespace argument: `planCatalog` already has one (`catalog.ts:757-765`).
  - One commit that applies N namespaces' schemas.
  - The validation walk per namespace.
  - The active schema per namespace (for `indexAuditDiff`).
  - Enforcement of a component's schema on writes is step 4, since nothing writes in a component before.

---

## 3. Proposed PR split (4 PRs, each testable alone)

### PR 1 — `bunvex/server`: `defineApp`, `defineComponent`, `app.use`, `componentsGeneric` (pure JS, no server)

- **Scope.** The npm side of §1.4, written from scratch with bunvex's messages:
  - the env refs Proxy;
  - `use` (with its name, prefix and env checks);
  - `export()` for the app and for components;
  - `componentsGeneric()`, `getFunctionAddress` for `_reference/…` (extend `function-handles.ts:105`);
  - the `ComponentDefinition` / `AppDefinition` / `EnvDefinition` types.

  Codegen's `components` stays `{}` (DV-174) until step 6.
- **Acceptance tests (mirroring Convex):**
  1. `defineApp().use(def)` with `def = {componentDefinitionPath: "counter", defaultName: "counter"}`, then
     `export()`, equals the captured `analysis[""].definition` minus `path`, the stored `type` field and
     `envVars`:
     `{definitionType:{type:"app"}, childComponents:[{name:"counter", path:"counter", args:[], env:[]}],
     httpMounts:{}, exports:{type:"branch",branch:[]}}`.
  2. A second `use(def, {name: "second"})`: order kept.
  3. `httpPrefix: "/x"` → `httpMounts {"/x/": "_reference/childComponent/<name>"}`. `"x"` throws.
  4. `env: {X: app.env.APPX, Y: "v", Z: undefined}` → `[["X",{type:"envVar",name:"APPX"}],["Y",{type:"value",
     value:"v"}]]`. `app.env.NOPE` throws. A number value throws.
  5. `defineComponent("c", {env: {X: v.optional(v.string())}}).export()` → `envVars
     [["X",{type:"value",value:"{\"type\":\"string\"}",optional:true}]]`. A non-validator throws.
  6. `componentsGeneric().a.lib.f` reference path `_reference/childComponent/a/lib/f`; `components` alone throws.
  7. Rule 5: no "convex" in the new code.

### PR 2 — `core`: namespaced writes and per-namespace schemas

Split in two (one concern each): **PR 2a** is `Tx.inComponent` and the `_component_definitions` rows; **PR 2b** is
the per-namespace schema push. As built, PR 2a:

- `db.inComponent(id, fn)` (`core/src/tx.ts`): while `fn` runs, names and id numbers resolve in the component's
  catalog; its own system tables (`COMPONENT_NAMESPACE_TABLES`) are the namespace's, the global ones (`_tables`,
  `_index`, `_components`, the index-id counter, …) the root's, by name and by id. Calls must not overlap (step 4's
  runtime runs nested calls one at a time). `null` is the root.
- A table a write creates inside a component is numbered in that namespace (`planCatalog`'s namespace) and is
  installed in the engine's `catalog.components` at commit. `TableDef.namespace` marks a component's tables.
- The root's schema checks (enforced, pending and staged validators) apply to the root's tables only: a
  component's `messages` is not the root's. A component's own schema is enforced from step 4.
- `catalogTouches` finds a component's table by tablet (`anyTablet`), so an index change on it conflicts as the
  root's do.
- `componentDefinitionRow` / `componentDefinitionMeta` (`core/src/components.ts`): Convex's
  `SerializedComponentDefinitionMetadata`, each child tagged `SerializedComponentInstantiation`, `envVars` null when
  empty, every map (`env`, `envVars`, `httpMounts`, a branch's exports, `args`) by key as Convex's `BTreeMap`;
  `componentRow` sorts `args` and `env` the same way. Checked against rows the Convex binary wrote for an app with
  env bindings, declared env vars and an HTTP mount (`core/test/convex-rows/component-definitions.json`).

Measured: an in-memory engine running 3000 mutations (insert, two `get`, `normalizeId`) and 3000 indexed queries,
median of 7 rounds, three alternated runs: 125–128 ms on main, 122–132 ms with PR 2a (noise).

As built, **PR 2b** (`core/src/engine.ts`):

- `startSchemaPush(schema, components)` takes each pushed component's schema (or null) by `_components` id, its
  namespace made by `initializeComponentNamespace`. In the start's ONE commit, after the root's, each component's
  tables and indexes are planned in its namespace (`planCatalog`'s namespace) and its schema submitted there:
  `submitPending`, Convex's `submit_pending`, extracted from the root's code and run with `db.inComponent`. A
  component without a schema gets none, as Convex's (`schema_id: None`). The result's `components` has each one's
  schema id and added indexes.
- The existing documents are walked per namespace (`validateExisting` and `failSchemaPush` take the namespace);
  `schemaPushStatus(schemaId, namespace)` reads the namespace's `_schemas` and counts its indexes.
- `commitSchemaPush(schemaId, body, components)` finishes every namespace in the push's ONE commit
  (`finishSchemaIn`, Convex's `commit_indexes_for_schema` + `mark_active`; `finishCatalog`'s namespace): a component
  not ready refuses the whole commit, so nothing applies. Its result's `components` has each one's index diff.
- `Engine.componentSchema(id)` is each component's active schema; a restart loads them and resumes a pending one's
  walk (`loadComponentSchemas`). Writes in a component are checked against its schema from step 4.
- Not yet for components, refused at the push with an error naming the table: staged validators (their walk and
  checks are the root's) and search and vector indexes (built for the root's tables). Staged database indexes work.

A component's new tables are numbered as the root's (`pushOrder`, #667): the tables with indexes first, by name,
then the rest by name, as Convex's binary does it (checked against it: `alpha`, `posts` with indexes are
10001–10002; `beta`, `users`, `zeta` without are 10003–10005).

Measured: a root push whose validator change walks 20 000 documents (`v.id` on a string field), median of 5, three
alternated runs: 94–100 ms on main and on this branch.

The plan as first written:

- **Scope.**
  - `Tx.inComponent(id)`;
  - the `_component_definitions` row (de)serialization (`componentDefinitionRow` / `Meta`);
  - a namespace argument through `startSchemaPush` / `schemaPushStatus` / `commitSchemaPush` / `finishCatalog`,
    with a multi-namespace commit;
  - the per-namespace active schema.
- **Acceptance tests:**
  1. On Convex's rows (`core/test/convex-rows/`; the binary fixture was removed, #661), every `_component_definitions` row round-trips
     unchanged, including `type: "SerializedComponentInstantiation"` and `envVars: null`.
  2. `inComponent(counterId).query("_modules")` returns `lib.js`, `schema.js` and `convex.config.js` of
     `counter` only. An insert into `inComponent(id)` of `messages` gets the namespace's table number (10002 in
     the fixture). The root sees nothing.
  3. A schema push to a fresh namespace creates its tables and indexes (numbers in name order from 10001,
     indexes backfilled then enabled), writes `_schemas` in that namespace, and leaves the root's untouched.
  4. A two-namespace commit is atomic: sabotage one and neither applies.
  5. `MAX_USER_TABLES` still counts across namespaces (step 1's test, extended).

### PR 3 — server `start_push` / `evaluate_push` / `evaluate_schema` / `wait_for_schema` with components

Built in three PRs: **3a** the definition evaluator, **3b** the tree's check and instantiation
(`component-tree.ts`), **3c** `start_push` and the rest wired to them.

As built, **PR 3a** (`server/src/definition-eval.ts`, nothing calls it yet):

- `evaluateDefinitions({app, components, env})` evaluates every definition the app's reaches, as Convex's
  `AppDefinitionEvaluator`: a post-order walk from `""` (each node's dependencies pushed in path order),
  `CyclicImport` on re-entering one in progress, a diamond's shared child evaluated again. Its result is each
  definition's metadata by path (`NewComponentDefinition`, core's `_component_definitions` row type).
- Each definition is a `vm.SourceTextModule` named `bunvex.config.js` in a fresh context (`contextGlobals` with
  Convex's refusals, each thrown into the code with Convex's text: `Date` (now, `new Date()`, `Date()`;
  `new Date(0)` works), `Math.random`, `crypto.getRandomValues` / `randomUUID`, `performance`, `fetch`,
  `setTimeout` / `setInterval`; `console` dropped; `process.env` the given variables in the app's and refused in a
  component's). A top-level await is refused after the synchronous part runs, as Convex checks the module's promise.
  One second to evaluate, Convex's `DATABASE_UDF_USER_TIMEOUT`.
- The linker: `./_componentDeps/<base64url>` is Convex's synthetic module, the child's
  `SerializedComponentDefinitionMetadata` (`componentDefinitionRow`: maps by key, `envVars` null when empty,
  children tagged) with its path and default name; `bunvex/server` and `bunvex/values` are the server's (DV-495);
  anything else is `NoImportModuleDuringDefinitionEvaluation`, located as Convex's
  `nicely_show_line_number_on_error` (`bunvex:/bunvex.config.js:<line>:<col>: …`, with the original line and its
  marker when the source map has the source).
- The default export's five checks, `export()` called, `path` injected, then serde's read (the first missing field
  in the struct's order, serde's `invalid type` / `unknown variant` wording) and Convex's `TryFrom` in its order
  (exports, env vars, path, definition type, children, mounts, prefix), each failure `InvalidDefinition` with
  Convex's text: identifiers (`@bunvex/values`' `identifierError`), definition paths (`definitionPathError`),
  `HttpMountPath`'s conditions, references, export names, env var names (`checkEnvVarName`).
- An exception from the definition's code is `InvalidBunvexConfig` with `describeUncaught`'s text.

Not as Convex, decided by the owner (§4 C-18 / DV-497, C-19 / DV-498):

- A bare import (`lodash`, `node:fs`) in a definition fails Convex's resolver as a 500; bunvex answers it as any
  other import, `NoImportModuleDuringDefinitionEvaluation` (400).
- An `export()` that throws is a 500 in Convex ("Failed to call export function", read from the source, not
  checked on the binary); bunvex answers `InvalidBunvexConfig` with the exception, as for the module's own code.

A top-level frame prints as the existing frame mapping prints it (`at bunvex.config.ts:5:15`), not as Convex's
`at <anonymous> (convex.config.ts:5:15)`: the same for every module's error since STUDY-95, not this PR's.

Measured (evaluating `defineApp` with N `defineComponent` children through `bunvex/server`, median of 7): 0.3 ms
for 1, 1.7 ms for 10, 6.1 ms for 50; the first evaluation in a process loads `bunvex/server` (~20 ms).

As built, **PR 3b** (`server/src/component-tree.ts`, nothing calls it yet):

- `checkEnvVarDeclarations(definitions)` is Convex's `validate_env_var_declarations`: by path, the app's first, every
  declared variable `v.string()`, a string literal or a union of those, else `InvalidEnvVarDeclaration`.
- `instantiateRoot(definitions)` is Convex's `TypecheckContext::instantiate_root` / `instantiate`, its checks in its
  order: the arguments (`check_args`; the legacy `args: null` initializer refused, C-13), each child's bindings
  against its declarations and its parent's (`validate_component_env`: a literal's value checked with
  `@bunvex/values`' `checkValue`, the parent's validator a subset of the child's with core's `isSubset`), the
  bindings resolved down the tree (the app's stay deployment variables; below, the parent's own binding, or dropped
  when the parent has none), each child's HTTP prefix (its mount path, under its parent's below the root),
  duplicate names, then the mounts (a direct child with HTTP routes, no overlap with a `/p/*` route of the parent's
  `http.js` or another mount), then the exports.
- `fileBasedExports(functions)` is Convex's `file_based_exports`: each public function at its module's path without
  `.js` and its name, `InvalidExport` on a clash, `InvalidModulePath` on a segment that is no path component.
- `serializedCheckedComponent(tree)` is Convex's `SerializedCheckedComponent`, every map by key;
  `componentsOf(tree)` lists the instances by path, parents first.
- The texts are Convex's byte for byte (C-5), Rust's `Debug` forms included (`[ComponentName(Identifier("counter"))]`,
  `ComponentDefinitionPath { path: "nope" }`, `HttpMountPath("/c/")`), and the unformatted
  `{definition_path:?}` of `type_checking.rs:149`.

Tests (`server/test/component-tree.test.ts`): each tree case of §1.10 (non-string declarations, a required variable
unbound, an undeclared one, a literal refused, undeclared and optional parent variables, a wider parent validator,
duplicate names, an unknown definition, a mount without routes, an overlap), the base tree's shape, prefixes, the
env chain two levels down, an unbound optional dropped, and one end to end from `bunvex/server`'s definitions.
Sabotage: 21 of 21 caught.

Measured (instantiating and serializing the tree, each component with 20 modules of 10 public functions, median of
7): 0.4 ms for 1 component, 2.7 ms for 10, 6.7 ms for 50.

PR 3c turned out larger than planned, so `evaluate_schema` per instance moves to a **PR 3d**: it needs the engine's
prediction (`Engine.evaluateSchema`) per namespace. Until then `evaluate_schema` still refuses components.

As built, **PR 3c** (`server/src/push.ts`, `server/src/push-components.ts`):

- **The request.** `appDefinition.definition` and `dependencies`, `componentDefinitions[]` and `forCodegen` are read
  as Convex's `into_project_config` reads them (`parsePushedComponents`):
  - each definition path is checked;
  - a `"use node"` module in a component is `InvalidConfig` "Node actions are not supported in components.
    Remove `"use node;" from lib.js", with no "while pushing" prefix.
  - The `ComponentsNotSupported` refusal moved from `start_push` to `finish_push`.
- **The size check.** One check over the total (`checkPackagesSize`): the app's package (its modules, schema and
  definition), one per component definition, and the external packages.
- **The evaluation** (`evaluateComponents`), as Convex's `evaluate_components`:
  - each component definition's modules are analyzed with the app's import seed and time and no variables, and its
    schema evaluated (a JS error is `InvalidSchema` with the exception alone);
  - the definitions are evaluated with 3a's evaluator, or Convex's default app when none is sent;
  - the declarations are checked and the tree instantiated with 3b's (`forCodegen` skips a child's required
    variables, as Convex's).
- **The schema change** (`startComponentSchemas`), as Convex's `start_component_schema_changes`:
  - the existing `_components` tree and the new one are walked together;
  - a new component's namespace is made (`initializeComponentNamespace`), and the app's first push allocates its id
    only (`Engine.allocateComponentId`);
  - each instance's index diff is computed against its active schema;
  - every namespace's schema is submitted in the root's start commit (#671).
  - A component's staged validator or search/vector index is refused first, as a 400 `ComponentsNotSupported`,
    before anything is allocated.
  - A dry run (and `forCodegen`) allocates and submits nothing (DV-444); its index diffs are each instance's against
    its active schema, or against nothing for a new one.
  - Convex allocates and submits in ONE transaction. bunvex allocates each namespace in its own commit before the
    schema start, which leaves the same rows when a push is abandoned (C-10).
- **The answer.**
  - `analysis` has one entry per evaluated definition: its metadata (a component's with its exports,
    `_reference/function/<module>:<name>`; the app's left empty), its schema and its modules' analysis.
  - `app` is 3b's `SerializedCheckedComponent`, which fixes C-14.
  - `schemaChange` has `allocatedComponentIds`, `schemaIds` and `indexDiffs` by component path.
  - Still as before: `componentDefinitionPackages` is `{}` and `udfConfig` null (bunvex writes packages at
    `finish_push`, C-9).
- **`wait_for_schema`** reads every path of `schemaIds` in its namespace: the app's, an existing component's, or the
  one the request's `allocatedComponentIds` names. A component existing under another id than the allocated one is
  a 409 `RaceDetected`, "Component {path} was created by a concurrent push" (the CLI pushes again); neither is a
  system error, as Convex's.
  - A failed schema names its `componentPath`; an overwritten one is a race.
  - `inProgress` lists every path's counts, a finished one's too: `Engine.schemaPushStatus` now answers `complete`
    with its index count, and an active schema's indexes are counted as Convex's `load_component_schema_status`
    counts them.
- **Not yet:**
  - A component's functions see no built-in variables (`BUNVEX_CLOUD_URL`, …) at analysis, where Convex's analyze
    supplies its defaults (step 4).
  - Existing component rows exist only from PR 4 on, so the walk's "existing" branches (kept, removed) are tested
    there.
- **The reference commit.** Convex's sources here were first read from a local checkout older than bunvex's
  reference (4577b9031, before d8bdde0, docs/parity/upstream.md). Two differences that matter were found at
  d8bdde0: the concurrent-push race above (in `wait_for_schema` and `finish_push`), and `file_based_exports`'
  `InvalidModulePath` text ("Invalid module path 'dir/my-mod': Path component my-mod can only contain …", over the
  path without `.js`), which PR 3b had in the older form. Both are fixed in PR 3c.

Tests (`server/test/push-components.test.ts`, over HTTP):

- **Success cases:**
  - the base push's answer (analysis, exports, the tree, ids, schema ids and index diffs by path, the namespaces'
    tables), then `wait_for_schema` complete;
  - `finish_push` refused, with the namespaces left in place;
  - a childless definition that finishes;
  - no definition at all;
  - a dry run that allocates nothing;
  - a component's failed schema naming its path.
- **Refusals:**
  - Node, an absolute path;
  - a cycle, a duplicate name;
  - a component's schema or module that does not load;
  - a search index in a component;
  - the total size.
- **Sabotage:** 17 of 17 caught.

Measured: a `start_push` of a 500-function app with no components spends 0.4 ms in the evaluation and the tree (the
app's exports, as Convex computes them), 0.1 ms in the schema walk and 0.1 ms in the answer (median of 9). End to
end, under load (load average ~9), the medians were 7.7–8.7 ms on this branch against 6.6–7.3 ms on main.

As built, **PR 3d** (`server/src/push.ts` `evaluateSchema`, `core/src/engine.ts` `evaluateSchema(next, namespace)`):

- **What `evaluate_schema` answers**, as Convex's `evaluate_schema_prediction`:
  - `componentSchemaEvaluations` has one entry per instance, by component path: the app's (there even with no
    `_components` row) and each other component's;
  - an unmounted instance whose definition is gone is skipped, and any other instance with no definition is a
    system error;
  - `newComponentDefinitions` lists the pushed definitions with no instance yet.
- **Each entry** is `predict_component_schema`:
  - for a definition the push does not carry, nothing (no tables, no indexes);
  - for one pushed without a schema, its indexes dropped and no table checked;
  - otherwise, `Engine.evaluateSchema` in the instance's namespace: its tables and their counts, its stored indexes,
    and its own active schema for the validation outcome and the search/vector indexes. A component has no staged
    validator or search index yet (PR 2b refuses them), so those parts are empty.
  - A component's schema error is `InvalidSchema` with the exception alone, as in `start_push`.

Tests (`server/test/push-components.test.ts`):

- no instance yet (a new definition);
- an existing instance predicted in its namespace (its documents counted, an added index backfilling over them,
  the app's prediction not seeing its table);
- the outcome against the component's own active schema (`supersetOfEnforced`);
- a definition not pushed, and one pushed without a schema;
- an unmounted instance whose definition is gone.

Sabotage: 7 of 8 caught. The one not caught names an id's table through the component's catalog. In a test-sized
table, a shape keeps ids as literal unions (Convex's shape rules), so no small test reaches it.

Measured: the app's `evaluate_schema` (20 indexed tables, no components) reads two system tables more. Median of 15,
five alternated runs after the first: 2.6–3.5 ms on this branch, 2.5–3.5 ms before it.


The plan as first written:


- **Scope.**
  - The request parsing (§2.1.1);
  - the definition evaluator (§2.3);
  - component analysis;
  - `component-tree.ts` (type checking, env chain, HTTP mounts, exports);
  - the per-namespace schema start;
  - the full start_push answer;
  - `wait_for_schema` over paths;
  - `evaluate_schema` per instance.

  `finish_push` still refuses component pushes until PR 4, with the existing `ComponentsNotSupported` moved
  there.
- **Acceptance tests** use hand-written requests (`sp.ts` style; definitions as plain `export default {export:
  () => ({...})}`, plus PR 1's real `defineApp` once merged). One test per row of §1.10's start_push table, with
  the same code, status and message structure (bunvex's words where C-3/C-4 say):
  - cyclic (self and two-node);
  - throws;
  - the five export-shape errors;
  - deserialize error;
  - Date, random, top-level await;
  - foreign import;
  - env in a component config; env in the app config succeeds;
  - Node module → `InvalidConfig` without prefix;
  - non-string env declarations (app and component);
  - missing, undeclared, bad-literal and undeclared-ref env;
  - required←optional;
  - duplicate name, bad and empty names;
  - unknown definition path, mount without routes, bad prefix, absolute path, component schema error.

  Success cases:
  - the base push answer equals the captured one structurally: `allocatedComponentIds` includes `""` on a first
    push; `schemaIds` and `indexDiffs` per path; `app` tree with `exports` leaves `{type:"function",
    path:{component:"second", udfPath:"lib.js:add"}}`; `analysis.counter.definition.exports` filled;
  - nested env resolution (`inner.Y = envVar APPX`);
  - an abandoned start leaves the allocated namespace (tables exist, no `_components` row);
  - a dry run allocates nothing (the read-only path).

### PR 4 — server `finish_push` with components (closes DV-429), and `/api/delete_component`

Built in two PRs: **4a** `finish_push` with components, **4b** `/api/delete_component`.

As built, **PR 4a** (`server/src/push.ts` `finishPush`, `server/src/push-components.ts` `finishComponents`,
`server/src/code-store.ts`):

- **ONE commit** (`Engine.commitSchemaPush` with every component's schema id), as Convex's `finish_push`:
  - the app's declared variables are checked: a required one unset is `MissingEnvironmentVariables` ("… Set them
    in the dashboard or CLI before pushing.", DV-494's words), and a set one failing its validator is
    `InvalidEnvironmentVariable`;
  - the auth;
  - the definitions diff: rows replaced or inserted, stored with their exports empty, and deleted when no longer
    pushed;
  - the tree diff, walked as Convex's `apply_component_tree_diff`, with each instance's code
    (`writeCodeRows` in its namespace: `_source_packages`, `_modules`), `_udf_config` (`setUdfConfigIn`: the
    definition's version with the app's seed; a change from "Unspecified version", null when unchanged) and crons
    (`applyInComponent`: rows only; they run from step 7);
  - the audit event with every component's diff, the app's first, then by path.
- **Each instance in the tree diff:**
  - created, its `_components` row inserted with the id `start_push` allocated (`importInsert`);
  - modified, or remounted when it was unmounted;
  - unmounted: its row `unmounted`, its `_modules` and crons cleared, its package, `_udf_config`, schema and data
    kept;
  - an instance already unmounted is left alone, as are its children;
  - an existing one whose id differs from the allocated one is a 409 `RaceDetected` (d8bdde0).
- **Packages.**
  - One per definition, written before the commit: the app's holds its definition module (`bunvex.config.js`,
    analyzed to nothing; `loadLatestCode` skips it, C-2), each component's its definition, schema and functions.
  - Two instances of one definition share the blob, each with its own `_source_packages` row.
  - After the commit, a package no namespace's row names any more is deleted (`referencedPackageKeys`).
- **The answer** (`SerializedFinishPushDiff`) has `definitionDiffs` (`{}` for each pushed and deleted definition)
  and each instance's diff by path: `diffType`, module diff (sorted, as Convex's `BTreeSet`), `udfConfigDiff`, cron
  diff, index diff and `schemaDiff`. `schemaDiff` is now filled for the app too, which fixes C-15.
- **A deploy that is not a push** (`deployCode`) still writes the default app's rows (`ensureRootComponent`); a push
  writes them from the evaluated tree.
- **Not yet:**
  - a component's function handles (Convex's `FunctionHandlesModel::apply_config_diff`, step 4);
  - `/api/delete_component` (PR 4b).
  - A component pushed without a schema keeps its earlier schema's indexes (Convex drops them).
  - The `finish_push` race, like the others, has no "while pushing" prefix: bunvex's route drops it for every
    `RaceDetected`.

Tests (`server/test/push-components.test.ts`):

- create, checked on the answer and the rows: the definitions with tagged children, the allocated ids, each
  namespace's modules, one blob shared by two rows, the app's seed in every `_udf_config`, each schema active, the
  audit event's order;
- remove `second` (unmount), remove it again (no diff), add it back (remount);
- every child and definition removed;
- the app's variables unset and invalid;
- the 409 race at finish;
- the app's code loaded back with its definition module beside it, and a shared blob kept.

Sabotage: 14 of 14 caught.

Measured: a whole push (start, wait, finish) of a 500-function app with no components, median of 11, five alternated
runs under load (load average ~9): 29.7–45.4 ms with this PR (median of medians 33.1) against 29.1–45.2 ms before it
(35.0). No difference shows above the noise; the finish reads each namespace's `_modules` once.

As built, **PR 4b** (`core/src/engine.ts` `deleteComponent`, `server/src/server.ts` `/api/delete_component`):

- **The route.** `POST /api/delete_component {componentId}`, with the `WriteData` operation, as Convex's
  `dashboard.rs`.
- **The commit** (Convex's `ComponentConfigModel::delete_component`):
  - the component and every one under it must be unmounted, else 400 `ComponentMustBeUnmounted`, "Component must
    be unmounted before deletion";
  - their `_components` rows are deleted;
  - every table of their namespaces, system tables included, is set `deleting`, and the deletion worker empties
    them;
  - the audit event `delete_component {component_id, component: <path>}` is written.
- **System errors, as Convex's:** the app (no id) is "Cannot delete root component", and an id that names no
  component fails Convex's `must_component_path`. Both are 500s.
- **After a restart,** a deleted component's tables being deleted go to the root's `deleting` (`buildCatalog`),
  which the worker resumes, and no catalog is left for the namespace.

Tests:

- a mounted component refused;
- an unmounted one deleted: its rows, its tables (its data and its system tables) emptied, the audit event, its
  sibling kept;
- a component with one under it: both deleted;
- the app and an unknown id;
- `buildCatalog` with a deleted component's tables.

Sabotage: 8 of 8 caught.


- **Scope.**
  - Definitions diff; tree diff (create / modify / remount / unmount);
  - per-namespace `_udf_config` / `_source_packages` / `_modules` (definition module included) / crons (rows
    only; the executor ignores non-root namespaces until step 7) / handles;
  - the schema commit;
  - blob refcounting;
  - `MissingEnvironmentVariables` / `InvalidEnvironmentVariable`;
  - the audit event per path;
  - `schemaDiff` in the answer.

  The bunvex CLI starts sending its own config module (C-1/C-8), or this waits for step 6, in which case DV-429
  closes in step 6.
- **`/api/delete_component`** (`application/src/lib.rs:2971-2994`, `config.rs:731-786`) is optional here, or
  step 9:
  - the whole subtree must be unmounted, else `ComponentMustBeUnmounted`;
  - an unknown id is 404 `ComponentNotFound`;
  - it deletes the rows, `_schemas` first, then every table of the namespace;
  - it audits `delete_component {component_id, component}`.
- **Acceptance tests:** the CLI sequence of §1.10 as hand-written start+finish pairs:
  1. **Create:** `counter` and `second`.
     - Answer: `definitionDiffs {"":{}, counter:{}}`; three `create` diffs; module diffs including the definition
       module and `schema.js`; `udfConfigDiff "Unspecified version"→<version>` per namespace; per-namespace index
       diffs; `schemaDiff.next_schema`.
     - Rows: equal in shape to the fixture's (the definitions with `type` in children; `_components` children
       `args: []`, `env: []`; two `_source_packages` rows sharing one `storageKey`; per-namespace `_udf_config`
       with the root's seed).
  2. **Remove `second`.** Its diff is `unmount` with `removed [<config>.js, lib.js, schema.js]`, and its row is
     `state: "unmounted"`. Its `_modules` are gone; `_source_packages`, `_udf_config`, `_schemas`, tables and data
     remain. Its `schemaIds` and `indexDiffs` are absent.
  3. **Re-add it:** `remount`, modules re-added, `udfConfigDiff: null`.
  4. **Remove every child and definition:** both unmount, the `counter` definition row is deleted, and the
     instance rows keep the dangling `definitionId`.
  5. **Unmount an already unmounted node:** no diff for it or its children.
  6. **App `env: {APPX: v.string()}` with APPX unset:** 400 MissingEnvironmentVariables. With APPX set to a
     value failing a literal: InvalidEnvironmentVariable.
  7. **A variable changed between start and finish:** RaceDetected (existing).
  8. **A concurrent create** of the same path under another id: 409 RaceDetected, "Component second was created
     by a concurrent push".
  9. **Audit row** `component_diffs` ordered root, `counter`, `second`, with `component_path` null / "counter" /
     "second".
  10. **A blob shared by two instances** survives unmounting one.
  11. **A Convex fixture store** with the definition module in its root package loads its root code (the C-2
      fix).
  12. **delete_component:** a mounted one → ComponentMustBeUnmounted; an unmounted one → rows and tables gone,
      audit event.

  Sabotage each, as the project requires.

PR 1 and PR 2 are independent. PR 3 needs PR 2 (and uses PR 1 in some tests). PR 4 needs PR 3.

---

## 4. Divergences and decisions

Rule 5 holds: "no exceptions, wire names included" (`scripts/check-deps.ts:8-12`). Every Convex name with
"convex" in it needs a bunvex name. 

| # | Where bunvex would differ | Convex | Recommendation | Decision |
|---|---|---|---|---|
| C-1 | **The definition module's name** on the wire (`definition.path`), as the server's expected filename, and as the `_modules` row (`convex.config.js`, `component_definitions.rs:482-483`) | `convex.config.js` | `bunvex.config.js` (source `bunvex.config.ts`): rule 5 leaves no choice. The server accepts any `definition.path`, as Convex's does (it ignores the path and uses its fixed filename), and stores it under that name | **Decided (owner, 2026-10-15): `bunvex.config.ts`** (DV-494) |
| C-2 | **Recognizing Convex's `convex.config.js`** in a Convex-written store without writing the literal | — | Role-based: never load a root-level module whose basename has more than one dot as a function module (Convex's own entry-point rule, which already excludes `auth.config.js`). Fixes a latent failure when such a store's package is readable | As recommended (internal; no DV) |
| C-3 | **The error code `InvalidConvexConfig`** (`deploy_config.rs:496`) | that code | `InvalidBunvexConfig` (bunvex's file name). Precedent: DV-307 / DV-312 renamed wire names | **Decided: `InvalidBunvexConfig`** (DV-494) |
| C-4 | **Messages naming Convex**: `invalid_export_value`'s "`convex.config.ts` … `import { defineApp } from 'convex/server'`" (`component_definitions.rs:316-337`); "Environment variables are only supported in the app's convex.config.ts. Learn more at https://docs.convex.dev/…" (`:548`); `MissingEnvironmentVariables` "Set them in the Convex dashboard or CLI"; `ConcurrentPush` "`npx convex dev`"; `use()`'s "This code only works in Convex runtime."; the importer frame `convex:/convex.config.js:0:14` | as quoted | Same structure, bunvex's words: `bunvex.config.ts`, `bunvex/server`, "the dashboard or CLI", `bunx bunvex dev`, "bunvex runtime", `bunvex:/bunvex.config.js`; docs links dropped (DV-04 / DV-356 precedent) | **Decided: bunvex's words** (DV-494) |
| C-5 | **Rust `Debug` formatting** in `TypecheckError` texts (`[ComponentName(Identifier("counter"))]`, `ComponentDefinitionPath { path: "" }`, `HttpMountPath("/c/")`, `Identifier("X")`), and the unformatted `{definition_path:?}` at `type_checking.rs:149` | as quoted | Match byte for byte (no "convex" in them; what a CLI user and a test see). Ask whether to keep the `:149` bug too: recommend matching it | **Decided: byte for byte**, the `:149` text included (no DV) |
| C-6 | **Config evaluation runtime**: a fresh V8 context per definition, Convex's globals refused | V8 | A fresh `vm` context per definition with the same refusals and texts. No divergence intended; note that Bun's `vm` cannot refuse everything V8's op layer refuses. Check `fetch`, `setTimeout`, `crypto.getRandomValues`, `performance.now`, and `Date` construction both as `new Date()` and `Date.now()` | As recommended (no DV intended) |
| C-7 | **Imports a definition may have**: Convex bundles `convex/server` into the config, and any other import is `NoImportModuleDuringDefinitionEvaluation` | only `_componentDeps/*` | **Divergence:** the server also links `bunvex/server` and `bunvex/values` (bunvex's CLI keeps `bunvex/*` external for functions; `bundle.ts:10, 35`), so a config bundle is ~1 KB, not ~22 KB. Accept self-contained bundles too. Alternative without a divergence: the CLI bundles `bunvex/server` in (step 6 choice) | **Decided: the server links `bunvex/server` and `bunvex/values`** (DV-495); self-contained bundles accepted too |
| C-8 | **DV-429 closure**: Convex's CLI always sends an app definition (synthetic `defineApp()` when the file is missing), so every 1.46 push stores the definition module in the root `_modules` | always | Step 6: bunvex's CLI sends a synthetic `defineApp()` module too (rows match). Until then the server accepts `definition: null` (Convex does: `default_root`) | As recommended (step 6; no DV) |
| C-9 | **The pending push in memory**: Convex echoes the whole `start_push` answer to `finish_push`; bunvex keeps it in memory (STUDY-35, existing) | stateless | Keep (existing design, documented: a restart → RaceDetected). With components the answer is larger but bunvex still reads only the ids from it. Not a new DV | Keep (existing; no DV) |
| C-10 | **Leaked namespaces**: an abandoned `start_push` leaves allocated namespaces (tables, no `_components` row) | leaks | Match (it is what Convex stores; an import or export of such a store must cope). No DV | Match (no DV) |
| C-11 | **Malformed `_componentDeps` targets** (an undecodable or unknown path, a dependency without a definition, dependencies with no `componentDefinitions`) are 500 InternalServerError | 500 | Recommend **400 `InvalidDefinition`** ("… does not name a pushed component definition") as a small DV: only a broken client reaches it, and bunvex's 500s page as internal errors. Or match the 500 if the owner prefers strictness | **Decided: 400 `InvalidDefinition`** (DV-496) |
| C-12 | **The `SerializedComponentInstantiation` tag** stored in each `childComponents` entry and answered | stored | Match (fixture and oracle; no "convex"). No DV | Match (no DV) |
| C-13 | **The legacy `_onInitCallbacks` initializer** for `args: null` instantiations | supported | Do not build (no 1.46 package produces `args: null`; CLAUDE.md: nothing kept only for old clients). Answer `TypecheckError` / `InvalidDefinition` instead. Small DV, or none if the owner accepts it under STUDY-139 | Not built (no client this side of 1.46 produces it: CLAUDE.md; no DV) |
| C-14 | **The `start_push` answer's `app`** today has `childComponents: []` (array) and lacks `httpPrefix` / `env` / `httpRoutes` / `exports` | map plus fields | Fix to Convex's shape (a parity bug, not a DV) | Fix (parity bug) |
| C-15 | **`finish_push`'s `schemaDiff`** is always null in bunvex's answer | filled | Fix (parity bug) | Fix (parity bug) |
| C-16 | **Crons in a component**: Convex writes them at push into the component's namespace and runs them | written and run | Write the rows in step 3 (PR 4); run them in step 7. Interim DV (the step-7 row) | Rows in step 3, run in step 7 (missing until then) |
| C-17 | **Wire names that keep "convex" by design** elsewhere: the `_componentDeps` prefix, `componentDefinitionPath`, `defaultName`, `_reference/childComponent/…` and `Symbol.for("toReferencePath")` contain no "convex"; the definition paths of Convex packages (`../node_modules/@convex-dev/…`) are user data | — | Keep as Convex's. Only C-1, C-3 and C-4 carry the word | Keep Convex's names (no DV) |
| C-18 | **A bare import in a definition** (`lodash`, `node:fs`): Convex's resolver (`deno_core::resolve_import`) fails it with no `ErrorMetadata`, a 500 | 500 | Answer it as any other import: 400 `NoImportModuleDuringDefinitionEvaluation` (DV-496's reasoning: only a broken client sends it) | **Decided: 400** (DV-497) |
| C-19 | **An `export()` that throws**: Convex's `export.call` gives no value and the push fails as a system error ("Failed to call export function"), a 500 (read from `component_definitions.rs:276-278`, not checked on the binary) | 500 | `InvalidBunvexConfig` with the exception, as the module's own exceptions | **Decided: `InvalidBunvexConfig`** (DV-498) |

---

## 5. Oracles (how to check each behaviour on the binary)

- **Setup.** This is what `` (captured run) did, and it reproduces in about 1 minute.
  1. Copy `cvx-comp-app` to a scratch directory, with the `node_modules` symlink.
  2. Start the binary: `convex-local-backend <db>/convex.sqlite3 --instance-name $(cat keybroker/dev/
     instance_name.txt) --instance-secret $(cat …/secret.txt) --port $P --site-proxy-port $((P+1))
     --local-storage <db>/storage --disable-beacon`.
  3. Run `bun tools/proxy.ts http://127.0.0.1:$P $((P+2)) log/`. It decompresses the CLI's brotli bodies for the
     log and forwards the raw bytes.
  4. Push with `CONVEX_SELF_HOSTED_URL=http://127.0.0.1:$((P+2)) CONVEX_SELF_HOSTED_ADMIN_KEY=$(cat
     admin_key.txt) ./node_modules/.bin/convex deploy -y --typecheck disable --codegen disable`.
  5. Kill both by PID at the end.
- **Where each behaviour is checked:**

  | Behaviour | Oracle |
  |---|---|
  | Wire shapes | `log/*start_push.{req,res}.json`, `*finish_push.res.json`, `*wait_for_schema*` |
  | Errors of `start_push` | `bun tools/sp.ts <case>`, which posts a mutated copy of the base request to the backend directly; each case in §1.10 is one name. New cases are one line: `appSrc(...)` / `compSrc(...)` with a plain-object `export()` |
  | Tree diffs (create / unmount / remount / all-unmount / definition deletion) | Edit `convex/convex.config.ts` and re-deploy through the proxy; compare `componentDiffs` and `definitionDiffs` |
  | Rows | `sqlite3 "file:<db>?mode=ro"` over `documents` (the latest `ts` per id): `definitionType` rows are `_component_definitions`, `definitionId` rows `_components`, `sourcePackageId` rows `_modules`, `storageKey` rows `_source_packages`, `serverVersion` rows `_udf_config`, `push_config_with_components` rows the audit log |
  | `MissingEnvironmentVariables` / `InvalidEnvironmentVariable` | `defineApp({env})` with the variable unset, or set (via `npx convex env set`) to a value failing a literal |
  | Concurrent create | Two `sp.ts` starts adding the same new child, then `finish_push` of the older one: the hand-written finish needs the echoed answer (`{adminKey, startPush, dryRun:false}`) |
  | `delete_component` | `POST /api/delete_component {componentId}` with the admin key, after an unmount |
  | Bun vs V8 runtime refusals (C-6) | `sp.ts` cases `date`, `random`, `fetchIt`; add `setTimeout`, `crypto.getRandomValues`, `performance.now` |
- **The bunvex side of each oracle:** the same `sp.ts` request against a bunvex dev server, with the
  `convex.config.js` path and the error code mapped per C-1 / C-3. A differential test (STUDY-122) could replay
  §1.10 against both.

## Divergences

| # | Divergence | Decision |
|---|---|---|
| DV-494 | The definition module is `bunvex.config.ts` / `bunvex.config.js`, its error code `InvalidBunvexConfig`, its messages in bunvex's words (C-1, C-3, C-4) | owner, 2026-10-15 |
| DV-495 | The server links `bunvex/server` and `bunvex/values` into a definition's bundle, so it need not carry them (C-7) | owner, 2026-10-15 |
| DV-496 | A malformed `_componentDeps` target is a 400 `InvalidDefinition`, not Convex's 500 (C-11) | owner, 2026-10-15 |
| DV-497 | A bare import in a definition is a 400 `NoImportModuleDuringDefinitionEvaluation`, not Convex's 500 (C-18) | owner, 2026-10-15 |
| DV-498 | An `export()` that throws is a 400 `InvalidBunvexConfig`, not Convex's 500 (C-19) | owner, 2026-10-15 |
