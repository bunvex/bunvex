# STUDY-13 — Validators (`v.*`) and argument / return validation

- **Status:** implemented (#24 validators; the next PR wires `args` / `returns` into functions)
- **Convex source read:** commit `4577b9031` of get-convex/convex-backend
- **Related:** [STUDY-18](STUDY-18-value-model.md) (values), STUDY-14 (schemas, next)

## 1. How Convex does it

### Validators, the JS side

`npm-packages/convex/src/values/validator.ts` and `validators.ts`:

- `v` builds immutable validator objects: `id(table)`, `null`, `number`/`float64`, `bigint`/`int64`,
  `boolean`, `string`, `bytes`, `literal(x)`, `array(e)`, `object(fields)`, `record(k, v)`, `union(...)`,
  `any`, `optional(x)` and `nullable(x)` (= `union(x, null)`). `commitTs` exists too.
- Every validator has:
  - `kind`;
  - `isOptional`: `"required"` or `"optional"`;
  - `json`, the form sent to the backend, e.g. `{ type: "string" }`, `{ type: "object", value: { f:
    { fieldType, optional } } }`;
  - `optional()`.
- **Composite validators** expose their parts:
  - `VObject` has `fields` and the helpers `omit`, `pick`, `partial` and `extend`;
  - `VArray` has `element`;
  - `VRecord` has `key` and `value`. Its keys and values can't be optional, and passing `undefined` as
    one of them throws;
  - `VUnion` has `members`.
- **Types:** `Infer<typeof validator>` gives the TypeScript type.

### Validation, the backend side

`Validator::check_value` in `crates/common/src/schemas/validator.rs`:

- **Scalars** match by type. `v.id(t)` needs a string that decodes to an id of table `t`.
  - An id of another table gives `TableNamesDoNotMatch`; one from a system table gives
    `SystemTableReference`.
  - A string that isn't an id, or names no table, gives `NoMatch`.
- **`literal`:** the value must be equal.
- **`array`:** every element is checked, with path `[i]`.
- **`record`:**
  - every key is checked as a string against the key validator, with path `.keys()`;
  - every value against the value validator, with path `.values()`.
- **`object`:**
  - every declared field must be present, unless it is optional (`MissingRequiredField`);
  - its value is checked, with path `.field`;
  - an undeclared field is `ExtraField`.
- **`union`:** the value must match one member (`NoMatch`, or the single member's own error).
- **`any`:** matches everything.
- **Error messages** carry `Path: …` (from the outermost level), `Value: …` and `Validator: …`, in Rust's
  display forms. For example, a float prints `1.0` and `NaN`, a string prints `"s"`, and validators print
  `v.object({a: v.string()})`.
- **Argument errors** are wrapped as `ArgumentValidationError: …` (`crates/udf/src/validation.rs`), and
  return errors as `ReturnsValidationError: …` (`crates/model/src/modules/function_validators.rs`).
- **Without an `args` validator**, arguments are unvalidated (any object).

## 2. What an app can observe

1. The `v` API: builders, `kind`, `isOptional`, the composite parts, the object helpers and `Infer`.
2. An argument or return value that doesn't match fails the call with the error kinds and message shapes
   above.
3. `v.id("t")` refuses an id of another table, and a string that isn't an id.

## 3. How bunvex does it

`@bunvex/values/src/validators.ts`:

- the same builders and classes, a `json` form with the same shape, and `Infer`;
- `checkValue(validator, value, tableOfId)` returns the error message, or null, with Convex's rules and
  message structure;
- `tableOfId` resolves an id's table (the engine's catalog), so `v.id` checks the table.

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| D1 | The validator marker is `isValidator`, not Convex's `isConvexValidator` | No "convex" in public names | accepted (owner rule) |
| D2 | `v.commitTs()` is not implemented | `db.vars.commitTs` doesn't exist yet (parity gap) | Decided (owner, 2026-10-01): match Convex (gap, to be built) (DV-59) |
| D3 | Error messages keep Convex's structure but never name Convex or link to its docs | Owner rule | accepted |
| D4 | Bytes in messages print as `ArrayBuffer(n bytes)` | Rust's `Bytes` display is internal; any readable form will do | accepted; confirmed by the owner, 2026-10-04 (DV-05) |

## 5. Tests

- Every builder: accepts what it should and refuses what it shouldn't, with the exact message.
- Paths through nested arrays, objects and records.
- `v.id` against the table resolver.
- `json` shapes, the object helpers, the `record` guards, and `Infer`, checked by the typecheck of a test
  file.

## 6. The builders' argument checks (2026-10-05)

### 6.1 How Convex does it

`npm-packages/convex/src/values/validators.ts` checks each builder's arguments when it is called. These are not
value checks.

- `throwUndefinedValidatorError(context, fieldName?)` (:12–22) catches `undefined` where a validator goes, which is
  usually a circular import. Its message is "A validator is undefined[ for field "<f>"] in <context>. This is
  often caused by circular imports. See https://docs.convex.dev/error#undefined-validator for details.". It is
  thrown by:
  - `v.object()` (:376), for the field's name; the next check is "v.object() entries must be validators";
  - `v.array()` (:569), with no field;
  - `v.record()` (:632–646), for `"key"` and `"value"`. Then come "Record validator cannot have optional keys",
    then "… optional values", and only then "Key and value of v.record() but be validators" (Convex's wording,
    typo included);
  - `v.union()` (:701), for `member at index <i>`, then "All members of v.union() must be validators".
    `v.nullable(x)` is `v.union(x, v.null())`, so it reports member 0.
- `v.id(tableName)` (:94) requires a string: "v.id(tableName) requires a string".
- `v.literal(value)` (:509–515) takes a string, number, bigint or boolean: "v.literal(value) must be a string,
  number, or boolean".
- `v.optional(undefined)` fails with the engine's own `TypeError`, in both.

### 6.2 What bunvex did, and does now

Before this section, bunvex had these differences:

- `v.object`, `v.array` and `v.union` did not catch `undefined`: an object said "v.object() entries must be
  validators; the entry for "<f>" is not", and an array was built;
- `v.record`'s `undefined` message had no "This is often caused by circular imports.", and its checks ran in
  another order with "must be validators";
- `v.literal` and `v.id` took anything.

Now every builder above throws Convex's message, in Convex's order (owner, 2026-10-05), from
`throwUndefinedValidator` in `packages/values/src/validators.ts`. Convex's docs link is left out (DV-358).

### 6.3 Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| B1 | The undefined-validator message has no "See https://docs.convex.dev/error#undefined-validator for details." | DV-04's rule (rule 5) | DV-358 (owner, 2026-10-05) |

### 6.4 Tests

- `packages/values/test/undefined-validators.test.ts`: each builder's `undefined` message, the non-validator
  messages, the record's order, and `v.literal` / `v.id`.
- `packages/sync-e2e/test/undefined-validators-oracle.test.ts`: the oracle. The same 16 calls against the
  official `convex/values` throw the same messages, once Convex's docs link is removed.

Sabotage checks, each caught:

| Sabotage | Caught by |
|---|---|
| `v.object` does not catch `undefined` | unit test, oracle |
| The record's non-validator message reworded | unit test, oracle |
| The union's member index off by one | unit test, oracle (`union`, `nullable`) |
| A bigint literal refused | unit tests |
| `v.id` takes `undefined` | unit test, oracle |
| The undefined-validator message changed | unit tests, oracle |
| `v.array` does not catch `undefined` | unit test, oracle |

## 7. A literal validator in messages (2026-10-05)

Convex shows a validator in a message (`Validator: …`, "does not match literal validator `v.literal(…)`") with
`Display for LiteralValidator` (crates/common/src/schemas/validator.rs:704–725). It prints JSON where JSON has a
form:

- a string, as JSON: `v.literal("a")`;
- a boolean: `v.literal(true)`;
- a finite number, through `serde_json`: `v.literal(2.0)`.

Otherwise it prints the type alone:

- any bigint: `v.literal(<bigint>)`, never its value (not `5n` or `5`);
- NaN and the infinities: `v.literal(<number>)`.

bunvex printed the bigint's digits (`v.literal(3)`) and `NaN` / `inf`. `displayLiteral` (check.ts) now prints
Convex's forms. `displayValidator` and the literal-mismatch message use it (owner, 2026-10-05).

A finite float literal is JSON as serde_json prints it, through `formatExportFloat` (`0.00005`, and `1e+21` once
#463 lands its `+`). It is not printed as a value's `{:?}`: values in messages are Rust's `{:?}` (`5e-5`, `1e21`),
literals serde_json's, as in Convex (STUDY-18 §8).

Tests (`packages/values/test/validators.test.ts`, "literals compare by type and value"):

- a bigint, NaN and −infinity literal, a string, a boolean and a float literal;
- a union with a bigint literal in a `Validator:` line.

Sabotage checks, each caught:

- a bigint printed as its number;
- infinity printed as itself;
- `displayValidator` not using the new form.
