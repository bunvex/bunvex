# STUDY-109 — The value nesting limit (64) on arguments, results and written values

- **Status:** implemented; the depth past serde's limit decided by the owner (2026-10-05, DV-363)
- **Convex source read:** `main` of get-convex/convex-backend (4577b9031), 2026-10-05
- **Related:** [STUDY-64](STUDY-64-sync-load.md) (the 16 MiB argument and result sizes), [STUDY-41](STUDY-41-nested-calls-and-execution-limit.md)
  (nested calls), [STUDY-53](STUDY-53-commit-timestamp.md) (the commit timestamp placeholder), the document nesting limit
  (16, `MAX_DOCUMENT_NESTING`, #35)

## 1. How Convex does it

### 1.1 The limit

`crates/value/src/size.rs:8` sets `MAX_NESTING = 64`. `Size::nesting` counts arrays and objects:

- a scalar (bytes and strings included) is 0;
- an array or object is 1 + its deepest element (an empty one is 1).

`check_nesting` (`size.rs:56-67`) fails past 64 with 400 `TooNestedError`,
"Value is too nested (nested {n} levels deep > maximum nesting 64)".

Every `ConvexValue` array and object checks it when it is built (`array.rs:93-94`, `object.rs:106-107`; the
pending-value nodes of a mutation's writes too, `pending.rs:190-196`). Values are built from their leaves up, so
the first level that fails is always 65: the message always says "nested 65 levels deep".

This is not the document limit. A stored document has its own limit of 16 (`crates/common/src/document.rs:102`),
which bunvex already has (`MAX_DOCUMENT_NESTING`, `tx.ts`).

### 1.2 Arguments

`parse_udf_args` (`crates/udf/src/helpers.rs:33-47`) turns the positional JSON arguments into a `ConvexArray`.
The arguments object sits inside that array, so it may nest at most **63** levels. A failure is a `JsError`:
"Invalid arguments for {path}: Value is too nested (…)", with the canonical path (`m.js:fn`).

`ValidatedPathAndArgs::new_inner` (`crates/udf/src/validation.rs:640-700`) runs the checks in this order:

1. visibility;
2. the function's type;
3. the parse (nesting);
4. the size (`validate_udf_args_size`);
5. the validator (`check_args`, which also refuses an argument that is not an object,
   `crates/model/src/modules/function_validators.rs:33-60`).

The same parse runs for every way a function is called:

- **From a client** (HTTP or WebSocket): `parse_udf_args` as above.
- **Scheduling** (`validate_schedule_args`, `validation.rs:181-203`): after the time checks and the target lookup,
  with the same message.
- **An action's `ctx.runQuery` / `runMutation` / `runAction`**: the arguments travel as JSON to the callee's
  `parse_udf_args` (`crates/isolate/src/environment/action/async_syscall.rs:142-149`).
- **A query's or mutation's `ctx.runQuery` / `runMutation`**: the `runUdf` syscall
  (`crates/isolate/src/environment/udf/async_syscall.rs:1640-1658`) first parses `args` as a value of its own,
  inside `with_argument_error("runUdf", …)`, before it resolves the function. Past 64 levels, it fails with
  "Invalid argument `args` for `runUdf`: Value is too nested (…)". At exactly 64 levels, it is the callee's
  `[args]` parse that fails, with "Invalid arguments for {path}: …".

### 1.3 Results

`deserialize_udf_result_inner` (`crates/isolate/src/helpers.rs:127-172`) runs in this order:

1. it parses the JSON;
2. it builds the value (nesting);
3. it checks the size;
4. later, the returns validator checks it.

A nesting failure is "Function {path} return value invalid: Value is too nested (…)". A result may nest 64 levels.
A mutation whose result fails commits nothing.

### 1.4 Written values

The database syscalls parse their `value` inside `with_argument_error`
(`crates/isolate/src/environment/helpers/mod.rs:39-56`):

- `db.insert` (`udf/async_syscall.rs:1288-1296`) parses `value` and then `table`.
- `db.replace` (`:1375-1386`) parses `id` and then `value`.
- `db.patch` (`:1335-1344`) parses `id` and then the patch: `PatchValue::from_uncommitted_json`
  (`crates/database/src/patch.rs:45-62`) parses **each field's value** as a value of its own. The patch object is
  no value, so a field may nest 64 levels.

Past the limit, each call fails with "Invalid argument `value` for `db.insert`: Value is too nested (nested 65
levels deep > maximum nesting 64)" (and the same for `db.patch` and `db.replace`). This happens before the
document is read or the table resolved, and before the document's own limit of 16 is checked, which only runs
when the document is built.

So, for a value written with `db.insert`:

- 17 to 64 levels give "Document is too nested (…)";
- 65 levels and more give the value message.

### 1.5 Past serde's 128

`serde_json::from_str` keeps its default recursion limit of 128. The `unbounded_depth` feature
(`Cargo.toml:201`) is only used to lift it in the persistence drivers. The limit applies to:

- the HTTP API's JSON body;
- a WebSocket message;
- a syscall's arguments;
- a function's result.

So a value that is over 128 JSON levels deep never reaches the nesting check:

- **HTTP:** the request is refused as invalid JSON.
- **WebSocket:** the message cannot be parsed.
- **Result:** "Function … failed. Could not parse return value as json: recursion limit exceeded …"
  (`FunctionReturnInvalidJson`).
- **Syscall:** its JSON error.

JSON levels also count the `$integer` / `$float` / `$bytes` wrappers. With thousands of levels, the JavaScript
side (`convexToJson`) overflows V8's stack first, and the app gets a `RangeError`.

## 2. What an app can observe

| What | Passes at | Fails at | Message |
|---|---|---|---|
| A function's arguments (client, scheduler, an action's call) | 63 | 64 | `Invalid arguments for m.js:fn: Value is too nested (nested 65 levels deep > maximum nesting 64)` |
| A query's or mutation's `ctx.runQuery` / `runMutation` arguments | 63 | 64 (the callee's message), 65+ | `Invalid argument \`args\` for \`runUdf\`: Value is too nested (…)` |
| A function's result | 64 | 65 | `Function m.js:fn return value invalid: Value is too nested (…)` |
| `db.insert` / `db.replace` value | 16 (the document limit) | 17–64: the document's message; 65+ | `Invalid argument \`value\` for \`db.insert\`: Value is too nested (…)` |
| `db.patch` field value | 15 (document) | 65+ in one field | `Invalid argument \`value\` for \`db.patch\`: …` |

The order is fixed:

- the nesting comes before the size, and both before the validators;
- a written value's nesting comes before the table or the document is looked at.

## 3. How bunvex does it

`@bunvex/values` exports `MAX_VALUE_NESTING` (64) and `TOO_NESTED_MESSAGE`.

- **Building a value from JSON.** `fromJsonValue` counts the levels as it goes down and throws past 64. It
  never goes below level 65, so a value of any depth fails cleanly. An encoded scalar (`$integer`, …) is no
  level, as in Convex. `copyValue` does the same, with an optional limit for a patch, which may be 65 deep.
- **Arguments and results.** `measureRawValue(v, maxNesting)` measures the size and the nesting in **the
  same single walk** as `rawValueSize`, and does not go below `maxNesting + 1`. `Functions.checkArgs` measures
  `[args]`, as Convex parses it. It checks the nesting, then the size, then whether the argument is an object, and
  then the validator: Convex's order. Before this study the object check came before the size; it now comes after.
  `checkReturns` checks the nesting and then the size.
- **Nested calls.** `runNested` (a query's or mutation's `ctx.runQuery` / `runMutation`) measures the arguments
  once, before it resolves the function. Past 64 levels it throws the `runUdf` message. Otherwise it hands the
  measurement to `checkArgs`. An action's calls go to `checkArgs` directly, as Convex's go to the callee.
- **Scheduling.** The scheduler measures `[args]` after resolving the target, before its commit-timestamp check.
- **Transports.** `fromWire` turns a stack overflow while stringifying the arguments (thousands of levels) into
  the nesting message. The query cache's key skips arguments too deep to stringify, so the run's own check
  reports them.
- **Written values.** The written value's first walk is `extractCommitTs` in `Tx.insert` / `patch` / `replace`.
  It checks the limit as it goes down: 64, or 65 for a patch (its fields are values). `insert` now runs it before
  it resolves the table, and `patch` / `replace` before they read the document, as Convex. The engine's own
  writes (`asSystem`) are exempt: a scheduled job keeps its arguments inside its document, which Convex stores
  as bytes.

**Measurement** (a scratch A/B bench: main's `value.ts` and this branch's loaded in one process, the median of 9 runs):

| Value | main's `rawValueSize` | `measureRawValue` (size + nesting) | size, then a separate `valueNesting` walk |
|---|---|---|---|
| `[{a, b, c: [1,2,3]}]` (small arguments) | 0.096 µs | 0.106 µs | 0.172 µs |
| 1000 string fields | 47.9 µs | 47.6 µs | 52.4 µs |
| 2000 rows (a large result) | 444.9 µs | 436.0 µs | 771.1 µs |

The fold costs about 10 ns on small arguments and nothing measurable on large ones. A separate walk would have
cost up to 75 %.

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| N1 | Past serde's 128 JSON levels, and past the JavaScript stack, bunvex still answers with the nesting message (a function error), where Convex answers with an invalid-JSON error, a "Could not parse return value as json" error, or a `RangeError` | Not possible to do the same without copying serde's limit into every parse. Convex's behaviour there is an accident of its JSON parser; the owner chose one clean message at every depth | owner, 2026-10-05: the message at every depth, never a stack overflow (DV-363) |

Matching Convex (no divergence): the limit, the messages, the 63/64 boundaries, the order (nesting, then size,
then validator; a written value before the table and the document), the `runUdf` message for a query's or
mutation's nested call, and a patch's per-field limit.

## 4b. Additions (beyond Convex)

None. `MAX_VALUE_NESTING`, `TOO_NESTED_MESSAGE` and `measureRawValue` join `rawValueSize` and `valueNesting` as
`@bunvex/values` exports the server uses.

## 5. Tests

- `packages/values/test/nesting.test.ts`:
  - `fromJsonValue` and `copyValue` at 64 and 65 levels;
  - an encoded scalar is no level;
  - 100 000 levels throw the message;
  - `measureRawValue`'s cap;
  - a property test: its size and nesting equal `rawValueSize` and `valueNesting` for any value.
- `packages/server/test/value-nesting.test.ts`:
  - arguments at 63 levels pass and 64 fail (query, mutation, action);
  - the nesting comes before the size, and the size before the object check and the validator;
  - results at 64 pass and 65 fail (query, action);
  - the nesting comes before the size and the returns validator;
  - a mutation whose result is too nested writes nothing;
  - 100 000 levels as arguments and as results (query, mutation, action) fail with the message;
  - a nested call gives the callee's message at 64 levels and `runUdf`'s from 65 on; an action's call gives
    the callee's;
  - scheduling: 63 levels schedule, 64 and 100 000 fail;
  - over HTTP and the WebSocket, at 64 levels and at 100 000, the arguments are a function error with the
    message, and the socket stays open.
- `packages/core/test/writes.test.ts`:
  - `insert` / `replace` at 65 levels give the value message, and at 64 the document's;
  - a patch field of 65 levels gives the value message, and of 64 the document's;
  - the value is checked before the table name and the document's existence;
  - 100 000 levels fail for insert, patch and replace, and the mutation writes nothing.

No oracle against the `convex` npm package: its client has no nesting check (the limit is the backend's), so
there is nothing on it to compare.

**Sabotage checks.** Each was applied alone, and the tests named failed. The code was restored after each one
(`git diff` clean).

| Sabotage | Failed |
|---|---|
| `MAX_VALUE_NESTING` 64 → 65 | 17 tests in the three files |
| `checkArgs` measures `args`, not `[args]` | 4 (arguments, order, nested call, transports) |
| `checkReturns` threshold +1 | 3 (results, mutation writes nothing, 100 000 levels) |
| size before nesting (in both checks) | 2 (the two order tests) |
| a patch limited to 64, not 65 | 1 (patch per-field) |
| no write limit (`writtenNesting` → ∞) | 4 (all write tests) |
| system writes not exempt | 1 (scheduling 63 levels) |
| `runUdf` threshold +1 | 1 (nested call) |
| `fromWire` does not map the stack overflow | 1 (transports) |
| `sizeOf` cap removed | 5 (100 000 levels ×2, cap, nested call, scheduling) |
| `fromJsonValue` threshold +1 | 2 (64/65, encoded scalar) |
| the query cache key does not skip a stack overflow | 1 (100 000 levels) |
| `replace` limited to 65 | 2 (insert/replace, order) |
| scheduler measures `args`, not `[args]` | 1 (scheduling) |

## 6. Open questions

None.

## Arguments too deep to stringify (2026-10-08)

Arguments thousands of levels deep are refused with the nesting message, as before; but in Bun (JSC) a
`JSON.stringify` that overflows the stack takes about 1.6 s to throw, whatever the depth past ~50 000 levels, so a
200 KB request of nested arrays held a CPU that long (twice over the sync protocol: once to measure, once to
convert). `deep-values.ts` walks the arguments first, without recursion, stopping past 1 000 levels (far above the
limit of 64, so no message changes), and each root once (the sync protocol measures, keys and converts the same
arguments). Measured: +0.35 µs a call for small arguments, +14% of the conversion for a 0.74 MB argument; the
100 000-level request is refused in ~50 ms instead of ~1.9 s.
