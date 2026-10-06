# STUDY-18 — The value model: types, order, index keys, JSON

- **Status:** implemented (#15 values, #21 core and wire); supersedes STUDY-05 D4/D6–D8 and STUDY-10 D1/D2/D10
- **Convex source read:** commit `4577b9031` of get-convex/convex-backend
- **Related:** [STUDY-05](STUDY-05-index-keys-and-ordering.md), [STUDY-10](STUDY-10-documents-and-values.md),
  [PERSIST-01](../specs/PERSIST-01-contract.md)

## 1. How Convex does it

### Types

`ConvexValue` in `crates/value/src/lib.rs`, with the JS side in `npm-packages/convex/src/values/value.ts`:

| Type | JS | Notes |
|---|---|---|
| Null | `null` | |
| Int64 | `bigint` | −2⁶³ … 2⁶³−1; out of range is an error |
| Float64 | `number` | NaN, ±Infinity, −0 and subnormals are all values |
| Boolean | `boolean` | |
| String | `string` | |
| Bytes | `ArrayBuffer` | |
| Array | `Value[]` | |
| Object | plain object | Fields are **sorted** by name; a field whose value is `undefined` is dropped |

- `undefined` is not a value. It stands for a *missing* field: in index keys it is its own value, below
  `null`.
- Anything else throws `… is not a supported Convex type`. That covers `Date`, `Map`, `Set`, class
  instances and functions.
- **Field names** (`validateObjectField`):
  - at most 1024 characters;
  - no leading `$`;
  - only non-control ASCII (32–126).

### Order and index keys

`crates/value/src/sorting.rs` follows FoundationDB's tuple layer:

- **Tags, in order:** undefined `0x01`, null `0x03`, int64 `0x04`…`0x0C` (the tag also carries the size
  and sign, so negatives sort first), float64 `0x0D`, false `0x0E`, true `0x0F`, string `0x10`, bytes
  `0x11`, array `0x12`, object `0x15`.
- **So the cross-type order is:** undefined < null < int64 < float64 < boolean < string < bytes < array <
  object.
- **Integers** are big-endian in 1, 2, 4 or 8 bytes, chosen by magnitude. Zero is the bare tag `0x08`.
- **Floats** use the IEEE-754 total order: flip every bit if the sign is set, otherwise flip only the
  sign bit, then write 8 bytes big-endian.
- **Strings and bytes** are escaped: `0x00` → `0x00 0xFF`. They end with `0x00`.
- **Arrays** list their elements, then `0x00`.
- **Objects** list `(escaped field name, value)` pairs in field order, then `0x00`. An empty field name is
  followed by `0xFF`.
- **The index key** (`IndexKey::to_bytes`, `crates/common/src/index.rs`) is the concatenation of the
  indexed values' sort keys (missing = undefined), then the document `_id` **as a string value**.

### JSON (the wire and the stored form)

`convexToJson` / `jsonToConvex`:

- `bigint` → `{"$integer": base64(8 bytes, little-endian)}`.
- A special float (NaN, ±Infinity, −0) → `{"$float": base64(8 bytes, little-endian)}`. Finite floats are
  plain numbers.
- Bytes → `{"$bytes": base64}`.
- Object keys are sorted.

### The value in an error message

`stringifyValueForError` (npm-packages/convex/src/values/value.ts) prints the value of every
"… is not a supported Convex type" / "undefined is not a valid Convex value" message, and the data of a
`ConvexError` as its message:

- `JSON.stringify` with a replacer: `undefined` → `"undefined"`, a bigint → `"5n"`; then cut at 16384
  characters with `[...truncated]`, never between the halves of a surrogate pair.
- The message is `${typeName}${value}`: `Set` / `Map` print their entries (`Set[1]`), a class instance its
  constructor name then its JSON (`Point {"x":1}`), a function `Function undefined`.
- Plain `JSON.stringify` semantics otherwise: a class instance's enumerable fields, its `toJSON` (a `Date`
  prints its ISO string) and getters run; a cycle throws `TypeError` from inside the message builder.
- It runs in the function's isolate, on the app's own objects. Convex's `ctx.db` and query objects are thin
  JS shells over syscalls, so their JSON holds no engine state.

### Long keys

- In the SQL stores (`crates/postgres/src/sql.rs`, `crates/common/src/index.rs`), a key is split into
  `key_prefix` (the first 2500 bytes) and `key_suffix`, plus `key_sha256`.
- Scans restore the true key order by buffering rows that share a full-length prefix.
- The observable order is always the order of the full key. This is PERSIST-01 bug B4, fixed in its own
  change.

## 2. What an app can observe

1. Every value round-trips exactly: bigint, bytes, NaN, −0, nested arrays and objects.
2. An unsupported value is refused when it is written, with Convex's message.
3. Documents come back with their fields sorted.
4. **Index order across types is Convex's.** Booleans sort after numbers, all ints before all floats, and
   a missing field sorts below `null`.
5. `eq("f", undefined)` matches documents where `f` is missing; `eq("f", null)` does not.
6. Objects, arrays and bytes can be indexed, and they order as described in §1.
7. On the wire, results and arguments use the `$integer`/`$float`/`$bytes` encoding.

## 3. How bunvex does it

- **`@bunvex/values`:**
  - `value.ts`: `Value`, `toJsonValue` / `fromJsonValue` (Convex's `convexToJson` / `jsonToConvex`; bunvex's public names carry no "convex"), `validateObjectField`, `compareValues`;
  - `sorting.ts`: `valuesToKey` (the tuple encoding above, with `undefined`).
- **`@bunvex/core`:**
  - `keyenc` is replaced by `valuesToKey`;
  - `indexKey` appends `_id` as a string;
  - documents are stored as `toJsonValue` text and read with `fromJsonValue`;
  - `patch` with `undefined` removes a field;
  - writes are validated as `toJsonValue` would (`copyValue`), so an unsupported type throws at the call.
- **Error messages** (`stringifyValueForError`, `displayValue`): plain data prints exactly as Convex prints
  it; a class instance, `Map`, `Set`, `Date` or function prints as `Name {…}` and is never opened (no
  field, getter or `toJSON` read), a cycle as `"[Circular]"`, and the walk stops at the 16384-character
  limit. bunvex's engine objects live in the same process as function code: `ctx.db` is the transaction,
  whose fields reach the catalog, the store and its recent writes, so opening it put them in a message the
  client receives (D2).
- **`@bunvex/server`:** decodes arguments with `fromJsonValue` and encodes results with `toJsonValue`.
- **Old stores are unreadable**, which is fine: there is no production data.

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| D1 | Public function names: `toJsonValue` / `fromJsonValue` instead of `convexToJson` / `jsonToConvex` | bunvex's public API carries no "convex" in its names (owner, 2026-09-30) | accepted |
| D2 | An error message prints a class instance as `Name {…}` (Convex: `Name {"field":…}`, its JSON), a `Date` as `Date {…}` (Convex: its ISO string), and a cycle as `"[Circular]"` (Convex: a `TypeError` from `JSON.stringify`) | Opening a non-plain object leaked the transaction, catalog and store state of bunvex's engine objects to the client; naming it is the bounded form that cannot leak | owner, 2026-10-03 (#308): accepted, option 1 (DV-316) |

## 5. Tests

- **Property:** for random values of every type, `compareValues(a, b)` has the same sign as the byte
  comparison of their keys.
- **Fixed order vectors:** undefined < null < −2⁶³n < −1n < 0n < 1n < −Infinity < −1 < −0 < 0 < 1 <
  Infinity < NaN < false < true < "" < "a" < bytes < [] < {}.
- **Round trips** through JSON for every special value. Refusals of `Date`, `Map`, `Set`, class
  instances, `$`-prefixed and control-character field names, and out-of-range bigint.
- **Error display** (`values/test/error-display.test.ts`): plain data prints as Convex's algorithm prints
  it (property test against it, cut included); class instances, cycles, huge and deep values; no getter or
  `toJSON` runs. `server/test/unsupported-value-leak.test.ts`: results, writes, arguments, `returns` and
  filter literals holding a query, `ctx.db`, `ctx` or a class instance give a short message with none of
  the engine's internals.
- **Engine:** a missing field vs `null` in an index; boolean after number; bigint and bytes stored and
  read back.

## 8. A float64's text (2026-10-05)

### 8.1 How Convex does it

Convex prints a float64 in two different ways.

- **In messages** (validation errors, `Value: …`, "Cannot negate …", and so on), a value is printed with
  `Display for ConvexValue` (crates/value/src/lib.rs:339). For a float that is `write!(f, "{n:?}")`, Rust's
  `{:?}` (`float_to_general_debug` in core::fmt::float):
  - the shortest digits that round-trip;
  - plain decimal for zero and for 1e-4 <= |x| < 1e16, always with a fractional part: `1.0`, `0.0001`,
    `9999999999999998.0`;
  - otherwise scientific, with no `+` and no point for a single digit: `1e16`, `1.5e-7`, `5e-5`;
  - `NaN`, `inf`, `-inf`, `-0.0`.
  - On an exact tie between two shortest candidates, Rust takes the upper one (`…2.3`, where JavaScript
    takes the even one, `…2.2`).
- **As JSON** (the snapshot export's lossless encoding, a literal validator's value), Convex uses serde_json. Its
  lockfile pins 1.0.151, whose float printer (`zmij`) writes:
  - plain decimal for 1e-5 <= |x| < 1e16, with `.0` after an integer;
  - otherwise scientific with a sign on a positive exponent: `1e+16`, `1e+21`, `1.5e-7`.
  - Ties go as JavaScript breaks them.

### 8.2 What bunvex did, and does now

- **Messages.** `displayValue` printed `${v}.0` for an integer below 1e16, and otherwise JavaScript's `String`. So
  it gave `10000000000000000`, `1e+21` and `0.00005`, and tie digits as JavaScript breaks them. It now uses
  `floatDebugText` (`packages/values/src/float-text.ts`), written from scratch to Rust's rules:
  - JavaScript's shortest digits (`toExponential()`), with an exact BigInt tie check that takes the upper
    candidate as Rust does;
  - the check only runs for 16 or more digits: with fewer, no two candidates can both round-trip.
  - It applies to every value shown in messages, nested ones too (owner, 2026-10-05).
- **The export.** `formatExportFloat` followed ryu's older layout (`1e16`). It now writes the `+` that Convex's
  pinned serde_json writes (`1e+16`). An export file now matches Convex's text for those floats; the importer
  read both forms already.

### 8.3 Divergences

None.

### 8.4 Tests and measurement

- **The reference.** A small Rust program, built against serde_json 1.0.151 (the version Convex's lockfile pins),
  prints `{:?}` and serde_json's text for f64 bit patterns. Against it, both formatters agreed on 2 000 000
  generated doubles, with 0 mismatches. The doubles were:
  - edge cases;
  - every power of ten and its neighbouring doubles;
  - mantissas times every power of ten;
  - random bit patterns;
  - the 1e-5..1e-4 band;
  - random 1–17 digit decimals.
- **The tests.** `packages/values/test/float-text.test.ts` checks:
  - 2 500 of those doubles from `fixtures/float-text.tsv` (bits, Rust's `{:?}`, serde_json's text);
  - the layout cases;
  - nested values in `displayValue`;
  - four tie cases taken from the reference.

  `export-json.test.ts` and `hot-paths.property.test.ts` now expect the `+`.
- **Sabotage checks**, each caught:
  - ties broken as JavaScript (tie test);
  - the small threshold at 1e-5, and the large one at 1e21 (fixture and layout tests);
  - the export without its `+` (3 tests);
  - `1.0e16` instead of `1e16` (fixture and layout tests).
- **Measurement.** `floatDebugText` costs about 540 ns per float on random 16–17-digit doubles, against 70–90 ns
  for the old `String`. This is only on the error-message path. `formatExportFloat`'s hot path did not change
  beyond one condition in its rare scientific branch.
