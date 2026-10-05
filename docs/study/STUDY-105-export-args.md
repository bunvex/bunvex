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

The parse itself (`JsonForm::json_deserialize`, crates/json_trait/src/lib.rs:38–45) has two steps, with the
messages below. The message after "Invalid JSON returned from …():" is the error's `Display`, which is its
outermost message.

1. **The shape.** `serde_json` reads the text into `ValidatorJson` (crates/common/src/schemas/json.rs:640–680). It
   is tagged by `type`:
   - `null`, `number`, `bigint`, `commitTs`, `boolean`, `string`, `bytes`, and `any` with its aliases `map` and
     `set`;
   - `literal {value}`, `id {tableName}`, `array {value}`, `record {keys, values}`, `object {value}`,
     `union {value}`;
   - a field is `{fieldType, optional}`.

   Any serde failure gets the context `invalid_json()`, whose message is "Invalid JSON". So bad syntax, an
   unknown `type`, or a missing or mistyped field all read "Invalid JSON". Serde's own words never show.
2. **The meaning.** `Validator::try_from` (json.rs:682–739) checks the following, in order:
   - a literal's value must convert to a value and be a number, a bigint, a boolean or a string: "Value
     `<v>` is not a valid literal.";
   - an id's table name is an identifier (`check_valid_identifier`'s messages);
   - an object's fields are taken in key order (a `BTreeMap`):
     - each name is a field name, then an identifier (`check_valid_field_name`, `check_valid_identifier`);
     - each validator's error is wrapped as "Invalid validator for key \`k\`: …";
   - a record's keys come first: they must be a subset of `v.string()`. Otherwise the message is "Records can
     only have string keys. Your validator contains a record with key typed as \`<display>\`, which is not a
     subtype of \`v.string()\`". Then come its values, then "Records cannot have string literal keys", then
     "Records cannot have optional values";
   - arrays and unions are checked member by member.

What Convex stores is the parsed validator serialized back (`json_serialize`):

- only the fields its type has;
- an object's fields in key order;
- `map` and `set` as `any`.

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
  - not a function, or a non-string result: Convex's messages;
  - otherwise the string is parsed as Convex's backend parses it (`validator-json.ts`, E2, owner 2026-10-05):
    - the shape serde accepts, or "Invalid JSON";
    - then each check of `Validator::try_from`, in its order and words, with "Error in args validator: " or
      "Error in returns validator: " before it;
    - then "Args validator must be an object or any".

    The JSON stored is the one Convex serializes back.

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
| E2 | The full parse is built and matches Convex (owner, 2026-10-05). Serde's wording was never at stake: every serde failure reads "Invalid JSON" in Convex too. What remains is in E3 | — | match Convex (owner, 2026-10-05) |
| E3 | What still differs in the parse: (1) "Error in args/returns validator: …" has no second line linking to Convex's docs; (2) a key repeated in one JSON object of the export is refused by serde for a struct (`duplicate field`, so "Invalid JSON"), while `JSON.parse` keeps the last one; (3) a literal value that does not convert gives bunvex's value-conversion message (`fromJsonValue`), not Convex's `json_to_value` one; (4) a float literal is stored as JavaScript prints it (`1`), where serde prints `1.0`. That is only visible in the stored analysis, since `apiSpec` parses it to the same number | (1) DV-04's rule. (2)–(4): we cannot do it, short of reimplementing serde_json's reader and printer; only a hand-written export reaches (2) and (3) | DV-357 (owner, 2026-10-05) |

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
| E2: an id's `tableName` not required | the parse test |
| E2: `$` field names allowed | the parse test |
| E2: the "Invalid validator for key" wrapper dropped | the parse test |
| E2: optional record values allowed | the parse test |
| E2: fields checked in written order, not key order | the parse test |
| E2: `map` stored as itself instead of `any` | the stored-JSON test |
| E2: string-literal record keys allowed | the parse test |

The E2 tests (`export-validators.test.ts`) cover:

- the shapes serde refuses ("Invalid JSON");
- a `$` field name and a non-identifier field name;
- an id's bad table name (wrapped with its key);
- a literal that is not one, with fields checked in key order;
- a record whose keys are not strings (a `v.float64()`, a union with a number literal), string-literal keys,
  and optional values;
- unions;
- the stored JSON: sorted fields, `map` / `set` as `any`, extra fields dropped.

## 6. Open questions

None.
