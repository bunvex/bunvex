# STUDY-100 — Index field references checked at push

- **Status:** implemented
- **Convex source read:** `main` of get-convex/convex-backend (4577b9031), 2026-10-04
- **Related:** [STUDY-35](STUDY-35-push-and-deploy.md) and [STUDY-56](STUDY-56-push-checks.md) (push), [STUDY-14](STUDY-14-schemas.md)
  (schemas), [STUDY-45](STUDY-45-text-search.md), [STUDY-51](STUDY-51-vector-search.md)

## 1. How Convex does it

`Application::_evaluate_schema` (`crates/application/src/lib.rs`) evaluates the schema module and checks
each database index's fields, appending `_creationTime`. It then calls `DatabaseSchema::check_index_references`
(`crates/common/src/schemas/mod.rs`). `evaluate_schema` wraps any error as
`Hit an error while evaluating your schema:\n{msg}`. These errors are not `JsError`s, so the push keeps their
code: 400 `SchemaDefinitionError`. The check runs for the push and for `evaluate_schema`. `start_push` wraps
the error once more as `Hit an error while pushing:\n{msg}` (`crates/local_backend/src/deploy_config2.rs`).

With `schemaValidation` off it checks nothing. Otherwise, table by table in name order:

1. **Every referenced field must exist** (`fields_referenced_in_indexes`). The fields are taken in this order:
   - the database indexes' fields, live ones in name order, then staged ones;
   - each text index's search field;
   - each text index's filter fields;
   - each vector index's vector field.

   A field fails when `DocumentSchema::can_contain_field` is false. The first failure is
   `In table "{table}" the index "{index}" is invalid because it references the field "{a.b}" that does not exist.`

   `can_contain_field` works like this:
   - A single-segment system field (`_…`) always passes.
   - `any` passes.
   - A union passes if any branch does.
   - An object needs the key, then checks the rest of the path in the field's validator; an optional field
     counts as its inner validator.
   - Anything else fails while path segments remain: a record, an array, a scalar.
2. **Every vector field must be able to hold an array of float64** (`overlaps_with_array_float64`).
   - Along the path, `any` and an undeclared object key pass, and a union passes if any branch does.
   - At the field, the validator must be `array(float64)`, `array(any)`, `any`, or a union containing one.
   - Otherwise the error is
     `In table "{table}" the vector index "{index}" is invalid because it references the field "{field}" that is neither an array of float64 or optional array of float64.`

The check does not cover a vector index's dimensions or filter fields, or the text field's type.

## 2. What an app can observe

A push, or `evaluate_schema`, whose schema indexes a field its validators do not have fails with the error
above (400 `SchemaDefinitionError`; the push's message starts with `Hit an error while pushing:`), and
nothing is pushed.

## 3. How bunvex does it

`indexReferenceError(schema)` in `@bunvex/core` `schema.ts` walks the validators' JSON with Convex's rules
and order, and returns the first message.

`push.ts` calls it right after the schema module evaluates, in `startPush` and `evaluateSchema`, and throws
`PushError("SchemaDefinitionError", "Hit an error while evaluating your schema:\n…")`. bunvex's other
push-time index checks already run earlier, in `defineSchema`: the names, the field counts and
`_creationTime`, as in Convex, where they also come before this one.

The check is not in `defineSchema`, because Convex's `defineSchema` does not make it. An engine opened
directly with such a schema still runs, as a Convex schema object would.

## 4. Divergences

None.

## 5. Tests

`packages/core/test/index-references.test.ts` covers:

- a missing database index field;
- validation off, or a `v.any()` table, checks nothing;
- nested paths through objects, optional fields, unions and `any`;
- records, arrays and scalars refused;
- search fields, filter fields and vector fields;
- vector field types, accepted and refused;
- Convex's order: tables by name, live indexes before staged ones, database before search before vector;
- system fields;
- a union branch without the vector field counts as able to hold it.

`packages/cli/test/deploy.test.ts` had a fixture indexing an undeclared field (`other`); it now declares it.
Every `examples/*/bunvex/schema.ts` passes the check.

`packages/server/test/push.test.ts` checks that such a push is a 400 `SchemaDefinitionError` with the
wrapped message, and that the old code keeps serving.

Sabotage checks, each caught:

- validation off not honoured;
- nested paths not followed;
- unions not searched;
- system fields not exempt;
- staged indexes not after live ones;
- tables not in name order;
- filter fields skipped;
- the vector element type not checked;
- an undeclared key not counted as eligible;
- the push not calling the check.

## 6. Open questions

None.
