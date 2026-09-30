# STUDY-13 — Validators (`v.*`) and argument / return validation

- **Status:** implemented (#24 validators; the next PR wires `args` / `returns` into functions)
- **Convex source read:** commit `4577b9031` of get-convex/convex-backend
- **Related:** [STUDY-12](STUDY-12-value-model.md) (values), STUDY-14 (schemas, next)

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
| D2 | `v.commitTs()` is not implemented | `db.vars.commitTs` doesn't exist yet (parity gap) | gap |
| D3 | Error messages keep Convex's structure but never name Convex or link to its docs | Owner rule | accepted |
| D4 | Bytes in messages print as `ArrayBuffer(n bytes)` | Rust's `Bytes` display is internal; any readable form will do | accepted |

## 5. Tests

- Every builder: accepts what it should and refuses what it shouldn't, with the exact message.
- Paths through nested arrays, objects and records.
- `v.id` against the table resolver.
- `json` shapes, the object helpers, the `record` guards, and `Infer`, checked by the typecheck of a test
  file.
