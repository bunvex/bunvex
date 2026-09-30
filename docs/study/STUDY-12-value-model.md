# STUDY-12 — The value model: types, order, index keys, JSON

- **Status:** implemented (#15 values, #20 core and wire); supersedes STUDY-05 D4/D6–D8 and STUDY-10 D1/D2/D10
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
  - `value.ts`: `Value`, `convexToJson`, `jsonToConvex`, `validateObjectField`, `compareValues`;
  - `sorting.ts`: `valuesToKey` (the tuple encoding above, with `undefined`).
- **`@bunvex/core`:**
  - `keyenc` is replaced by `valuesToKey`;
  - `indexKey` appends `_id` as a string;
  - documents are stored as `convexToJson` text and read with `jsonToConvex`;
  - `patch` with `undefined` removes a field;
  - writes are validated through `convexToJson`, so an unsupported type throws at the call.
- **`@bunvex/server`:** decodes arguments with `jsonToConvex` and encodes results with `convexToJson`.
- **Old stores are unreadable**, which is fine: there is no production data.

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| — | none intended | | |

## 5. Tests

- **Property:** for random values of every type, `compareValues(a, b)` has the same sign as the byte
  comparison of their keys.
- **Fixed order vectors:** undefined < null < −2⁶³n < −1n < 0n < 1n < −Infinity < −1 < −0 < 0 < 1 <
  Infinity < NaN < false < true < "" < "a" < bytes < [] < {}.
- **Round trips** through JSON for every special value. Refusals of `Date`, `Map`, `Set`, class
  instances, `$`-prefixed and control-character field names, and out-of-range bigint.
- **Engine:** a missing field vs `null` in an index; boolean after number; bigint and bytes stored and
  read back.
