# STUDY-105 — `exportArgs()` / `exportReturns()` on registered functions

- **Status:** implemented
- **Convex source read:** `main` of get-convex/convex-backend (4577b9031), 2026-10-05
- **Related:** [STUDY-35](STUDY-35-push-and-deploy.md) (the push's analysis), [STUDY-36](STUDY-36-codegen.md)
  (`args` / `returns` as `v.object`), [STUDY-66](STUDY-66-server-api-gaps.md) §7 (registration guards)

## 1. How Convex does it

**The methods.** `npm-packages/convex/src/server/impl/registration_impl.ts` gives every registered function two
methods. All six builders do it (`mutationGeneric`, `internalMutationGeneric`, `queryGeneric`,
`internalQueryGeneric`, `actionGeneric`, `internalActionGeneric`, lines 258–676), with plain assignments
(`func.exportArgs = exportArgs(functionDefinition)`). So both are own, writable, enumerable properties of the
function.

- `exportArgs()` (:172–183): `JSON.stringify(args.json, strictReplacer)`.
  - `args` is `asObjectValidator(definition.args)`: an object of field validators becomes `v.object` of them.
  - Without `args`, or for a bare handler, it is `v.any()`, so the result is `{"type":"any"}`.
- `exportReturns()` (:185–196): `JSON.stringify(returns ? returns.json : null, strictReplacer)`, with `returns`
  made the same way. Without `returns` the result is the string `"null"`.
- `strictReplacer` (:162–171) throws for an `undefined` value: "A validator is undefined for field "<key>". This
  is often caused by circular imports. See https://docs.convex.dev/error#undefined-validator for details."
  The validators' constructors catch most such cases first (`values/validators.ts`, `throwUndefinedValidatorError`).
- The types (`server/registration.ts:528–589`): `RegisteredMutation`, `RegisteredQuery` and `RegisteredAction`
  declare `exportArgs(): string` and `exportReturns(): string`, each `@internal`.

**The analysis.** At a push, `crates/isolate/src/environment/analyze.rs` reads them for each exported function
(`parse_args_validator`, :482–530; `parse_returns_validator`, :532–580). The identifier in the messages is
`<module path>:<export name>`, for example `messages.js:send` (`CanonicalizedModulePath`'s `Debug` is the bare
path).

| The property | Args | Returns |
|---|---|---|
| a function | called; its result is parsed | the same |
| `undefined` or absent (before npm 0.13) | `Unvalidated` | `Unvalidated` |
| anything else | "`<id>`.exportArgs is not a function or \`undefined\`." | "`<id>`.exportReturns is not a function or \`undefined\`." |
| the call returns a non-string | "Invalid exportArgs return value: `<id>`.exportArgs() didn't return a string." | the same, with `exportReturns` |
| the string does not parse | "Invalid JSON returned from `<id>`.exportArgs(): `<parse error>`" | the same, with `exportReturns` |

The parse (`crates/model/src/modules/function_validators.rs`) takes JSON, then a validator from it:

- `ArgsValidator` (:100–117) must be an object validator, or `any` (`Unvalidated`). Anything else is "Args
  validator must be an object or any".
- `ReturnsValidator` (:187–206) is `null` (`Unvalidated`) or any validator.
- A malformed validator is "Error in args validator: …" or "Error in returns validator: …", with a docs link.

These errors are a `JsError` from `udf_analyze`. `Application::start_push` (crates/application/src/lib.rs:2896)
reports them as `InvalidModules`: "Loading the pushed modules encountered the following error:\n<message>".
`start_push`'s route then prefixes "Hit an error while pushing:\n" (local_backend/src/deploy_config2.rs:323).

A method that **throws** (the strict replacer, or user code) is different. `with_try_catch(...)??` turns the
`JsError` into an `anyhow` error through `From<JsError> for anyhow::Error` (common/src/errors.rs:579). That error
is a 400 `bad_request("Error", "<Uncaught …>\n<frames>")`, with no `InvalidModules` header.

**Storage.** `AnalyzedFunction::new` (crates/model/src/modules/module_versions.rs:296–312) stores
`args.json_serialize()` and `returns.json_serialize()` as strings:

- `ArgsValidator::Unvalidated` serializes as `Validator::Any`: `{"type":"any"}`;
- `ReturnsValidator::Unvalidated` serializes as `ReturnsValidatorJson(None)`, which serde writes as `null`. So
  the stored string is `"null"`.

**`apiSpec`.** `npm-packages/system-udfs/convex/_system/cli/modules.ts:21–44` reads `_modules`:
`fn.returns ?? DEFAULT_RETURN_VALIDATOR`, then `jsonToConvex(JSON.parse(…))`. The stored string `"null"` is not
nullish, so it parses to `null`. A function without `returns` therefore has `returns: null` in `apiSpec`, and in
`npx convex function-spec`. A function without `args` has `args: { type: "any" }`.

## 2. What an app can observe

- Every registered function has `exportArgs` and `exportReturns`, own properties that return the strings above.
- `function-spec` (`_system/cli/modules:apiSpec`) shows `returns: null` for a function that declares none.
- A push fails with the messages above when an export's methods are broken, for example overwritten. A push
  also fails when a function's `args` is a validator other than an object or `v.any()` (`args: v.string()`).
- A method that throws fails the push with code `Error` and the thrown error.

## 3. How bunvex does it

Before this study:

- `builders.ts` `define` made no methods;
- `code-version.ts` recorded `JSON.stringify(value.args?.json ?? { type: "any" })`, and the same for `returns`.
  So a function without `returns` stored `{"type":"any"}`;
- `functions.ts` `apiSpec` used `{ type: "any" }` for both, from the validators directly.

Now (`@bunvex/server`):

- **The methods.** `define` (builders.ts) assigns `exportArgs` and `exportReturns` with the other markers
  (`Object.assign`), so they are plain own properties, on every builder's functions, internal ones too. They
  stringify the normalized validators (`asObjectValidator` already ran in `defineUnmarked`) with bunvex's
  strict replacer. The replacer has Convex's message without the docs link (DV-355). `registration.ts` declares
  both on the registered types, `@internal`.
- **One source.** `exportedValidator(f, method, id)` (builders.ts) is what Convex's analyze does with one
  method:
  - absent: `{"type":"any"}` or `"null"`;
  - not a function, a non-string result, unparseable JSON: Convex's messages;
  - an args validator that is neither an object nor `any`: Convex's message.

  Both readers go through it:
  - the push's analysis (`code-version.ts` `analyzeExport`) stores its string;
  - `apiSpec` (functions.ts) parses its string. So a function without `returns` reports `returns: null`, as
    Convex.
- **Errors.** A malformed export is an `InvalidModulesError` (`InvalidModules`, with its header). An error the
  method throws is a `FunctionExportError` (400, code `Error`, `Uncaught …` and the app's frames). `push.ts` maps
  it to a `PushError` with that code. The server adds "Hit an error while pushing:" to both, as for every push
  error.
- **The run time.** Validation at run time (`checkArgs`, `checkReturns`) still uses the validators themselves,
  not the JSON. Convex's run time parses the stored JSON, but the two cannot differ for a function made by
  bunvex's builders.

This is not a hot path: the methods run once per function at a push, and on an `apiSpec` call.

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| E1 | The strict replacer's message has no docs link | DV-04's rule: messages never link to Convex's docs | DV-355 (owner rule, 2026-10-05) |
| E2 | *gap, pending:* an export's JSON is only checked for syntax, and for `args`, for an object or `any`. Convex parses the validator (`Validator::try_from`): a malformed one is "Error in args validator: …". Its parse errors are serde's words, which bunvex cannot reproduce: it reports `JSON.parse`'s message after Convex's prefix | Only an export overwritten by hand reaches it; bunvex's builders always produce valid JSON | question for the owner (in the PR) |

Before this study bunvex had another difference: `returns: {"type":"any"}` for a function without `returns`.
It now matches Convex (`null`), as the owner decided (2026-10-05), so it needs no row.

## 4b. Additions (beyond Convex)

None.

## 5. Tests

- `packages/server/test/export-validators.test.ts`:
  - all six builders have both methods as own, writable, enumerable properties;
  - the defaults: `{"type":"any"}` and `"null"`;
  - an object of fields becomes `v.object`, for `args` and `returns`; a validator gives its JSON (a bigint
    literal too);
  - the analysis stores the methods' strings, and an export without them is unvalidated;
  - each broken export gives Convex's message: not a function, a non-string, bad JSON, a non-object args
    validator, `args: v.string()`;
  - a throwing method is a `FunctionExportError` (400, `Error`);
  - the strict replacer's message, without a link;
  - `apiSpec` reports `returns: null` for a function without one.
- `packages/server/test/push.test.ts`: over HTTP, a broken `exportArgs` is a 400 `InvalidModules` with the full
  message. A throwing `exportReturns` is a 400 `Error`. Nothing is deployed.
- `packages/sync-e2e/test/export-validators-oracle.test.ts`: the oracle. The official `convex` package's six
  builders and bunvex's give the same `exportArgs()` and `exportReturns()` strings, for six definitions. Both
  methods are own properties in both.
- `packages/cli/test/function-spec.test.ts`: `function-spec` prints `returns: null` for a function without one.

Sabotage checks, each caught:

| Sabotage | Caught by |
|---|---|
| `exportReturns` without `returns` gives `{"type":"any"}` | builders, analysis, `apiSpec`, `function-spec`, oracle |
| A missing method defaults to `{"type":"any"}` for returns too | analysis (no methods) |
| `string` accepted as an args validator | analysis (broken exports) |
| A throwing method reported as `InvalidModules` | analysis (throws), push over HTTP |
| The strict replacer never fires | strict replacer test |
| `apiSpec`'s `returns` read from `exportArgs` | `apiSpec`, `function-spec` |
| The "not a function" message changed | analysis (broken exports), push over HTTP |

## 6. Open questions

- E2: should bunvex parse an export's validator JSON fully, with Convex's "Error in args validator: …" messages
  (still without serde's exact parse-error words)? Only a hand-overwritten export reaches it.
