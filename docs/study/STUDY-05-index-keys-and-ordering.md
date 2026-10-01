# STUDY-05 — Value order, index keys and system indexes

- **Status:** implemented / decided — every row fixed (#6, #10, #21; Phase 0 B5, B6, B11) or resolved to match Convex (DV-33–DV-37); D13 is the same in both systems. Retroactive: the code in §3 was written before the study-first rule.
- **Convex source read:** commit `4577b9031` of get-convex/convex-backend
- **bunvex code read:** `main` at `f60e934` (after #3 and #4)
- **Related:**
  - [STUDY-01](STUDY-01-document-ids.md): the `_id` format, which is the last element of every key.
  - [STUDY-10](STUDY-10-documents-and-values.md): which values can exist at all.
  - [PERSIST-01](../specs/PERSIST-01-contract.md) C1/C2: keys are opaque bytes in memcmp order.

## 1. How Convex does it

### 1.1 The total order of values

`crates/value/src/sorting.rs` defines the order of every Convex value. It does this by encoding a
value into a **sort key** (a byte string) and comparing the bytes. The layout follows FoundationDB's
tuple layer. `impl Ord for ConvexValue` in the same file is proptested to agree with it.

| tag | type | payload |
|---|---|---|
| `0x01` | `undefined` (a missing field) | none |
| `0x03` | `null` | none |
| `0x04`–`0x0C` | Int64 (`bigint`) | 0, 1, 2, 4 or 8 big-endian bytes; the tag holds the sign and the width, so negatives sort first |
| `0x0D` | Float64 (`number`) | 8 bytes in IEEE-754 **total order**: sign bit set → all bits flipped, otherwise only the sign bit is flipped |
| `0x0E` / `0x0F` | `false` / `true` | none |
| `0x10` | string | UTF-8; `0x00` escaped as `0x00 0xFF`; ends with `0x00` |
| `0x11` | bytes (`ArrayBuffer`) | same escaping as string |
| `0x12` | array | the elements' sort keys, then `0x00` |
| `0x15` | object | per field: escaped name, then the value's sort key; then `0x00`. Fields go in name order, because `ConvexObject` is a `BTreeMap` |

The cross-type order is therefore:

`undefined < null < Int64 < Float64 < boolean < string < bytes < array < object`

Floats are **not** normalised:

- `-0.0 < +0.0`, so `eq("f", 0)` does not match a document holding `-0`.
- `NaN` with the sign bit clear sorts after `+Infinity`; a NaN with the sign bit set sorts before
  `-Infinity`.

`write_sort_key_or_undefined` writes the `0x01` tag for a missing field, so **a missing field is not
`null`**.

### 1.2 Index keys

`crates/common/src/index.rs`:

- `IndexKey` is `(values of the indexed fields…, _id)`.
- `to_bytes` concatenates the sort keys. The `_id` goes last, as a **string** value (tag `0x10`).
- `IndexedFields::iter_with_id` (`crates/common/src/bootstrap_model/index/database_index/indexed_fields.rs`)
  is the field list with `_id` appended.

Field paths may be nested (`"a.b"`). A missing path gives `undefined`.

### 1.3 System indexes and the implicit `_creationTime`

Every table has two system indexes:

- `by_id`: fields `[]`, so the key is `[_id]`;
- `by_creation_time`: fields `[_creationTime]`, so the key is `[_creationTime, _id]`.

(`IndexedFields::by_id()` and `IndexedFields::creation_time()`, and
`crates/common/src/types/index.rs`.)

A query without `withIndex` is a `FullTableScan`. It reads `by_creation_time`
(`crates/database/src/query/mod.rs`, the `QuerySource::FullTableScan` arm).

**Every user index gets `_creationTime` appended.** `_validate_user_defined_index_fields`
(`crates/application/src/lib.rs:2048`) does it, "so indexes have default order that is more intuitive
to the user". It also enforces rules on the declared fields:

- declaring `_creationTime` yourself is rejected (`IndexFieldsContainCreationTime`);
- any `_`-prefixed field is rejected (`IndexFieldNameReserved`);
- `_id` is rejected (`IndexFieldsContainId`);
- a field listed twice is rejected;
- at most 16 fields (`MAX_INDEX_FIELDS_SIZE`, `crates/common/src/bootstrap_model/index/mod.rs`).

So `index("by_channel", ["channel"])` is stored as `["channel", "_creationTime"]`, and its key is
`[channel, _creationTime, _id]`. Two consequences:

- Documents with the same `channel` come back **in creation order**.
- `_creationTime` can be used in the range expression:
  `q.eq("channel", c).gt("_creationTime", t)`. `IndexRange::compile` in `crates/common/src/query.rs`
  checks range fields against the fields including `_creationTime` and the implicit `_id`.

### 1.4 `_creationTime` values

`CreationTime::for_transaction` and `CreationTime::increment` are in `crates/common/src/document.rs`.
`UserFacingModel::insert` (`crates/database/src/bootstrap_model/user_facing.rs`) uses
`next_creation_time.increment()`.

- The first value is the **wall clock in milliseconds with a fractional part** (nanosecond
  resolution), and never below the snapshot timestamp.
- Each insert in the transaction then takes the next float (`next_up`).
- So `_creationTime` looks like `1727651234567.1235`. Two mutations in the same millisecond still
  get different creation times, in practice in arrival order.

### 1.5 Index backfill

A newly declared index is built over the existing documents before queries can use it
(`crates/database/src/database_index_workers`, the `index_backfills` system table).

## 2. What an app can observe

1. **Order inside equal index values** is creation order, because of the implicit `_creationTime`.
   For example, the messages of a channel through `by_channel`.
2. **Default query order** (no index) is `_creationTime`, which is effectively insertion order even
   across concurrent mutations.
3. `_creationTime` can appear in a `withIndex` range after the equality fields.
4. **Mixed-type fields** sort `undefined < null < bigint < number < boolean < string < bytes <
   array < object`.
5. **`eq("f", undefined)`** matches documents where `f` is missing. `eq("f", null)` matches only an
   explicit `null`.
6. **Arrays, objects, bytes and bigints** can be indexed and compared: arrays element by element,
   objects field by field in name order.
7. **`-0` and `0` are distinct keys.** NaN and ±Infinity are ordinary, ordered keys.
8. **Index definitions are validated:** reserved fields, duplicates, `_creationTime`, and at most 16
   fields.
9. **A new index returns complete results** once the push finishes (it is backfilled).

## 3. How bunvex does it today

`packages/core/src/keyenc.ts`:

- Tags: `null 0x01 < false 0x02 < true 0x03 < number 0x04 < string 0x05 < bytes 0x06`.
- Numbers are always f64. `-0` is normalised to `+0` (`pushNumber`).
- Strings and bytes use the same `0x00 → 0x00 0xFF` escape and `0x00` terminator as Convex.
- `encodeKey` has **no branch for** `undefined`, `bigint`, arrays or objects. Anything that is not
  null, a boolean, a number or a string falls into the `else` branch and is treated as a byte array
  (`pushEscaped(v)`):
  - An object has no `.length`, so every object encodes as `06 00`, and **all objects are equal**.
  - An array of strings pushes the strings into a number array, and `Uint8Array.from` turns them into
    `0`. Arrays become garbage keys: `["a","b"]` → `06 00 00 00`.
  - `undefined` throws `TypeError: undefined is not an object (evaluating 'bytes.length')`. This was
    checked on Bun 1.4.2.

`packages/core/src/schema.ts`:

- `Schema.table` adds `by_id` (`["_id"]`) and `by_creation_time` (`["_creationTime"]`), then the
  declared indexes **as given**. There is no `_creationTime` appended and no validation.
  - A user index named `by_id` or `by_creation_time` replaces the system entry in the `indexes` map.
    `t.byId` still points to the old definition.
- `indexKey` reads `doc[f]`, a top-level property only, so there are no nested paths.
  - A missing field (`undefined`) is encoded as **`null`**.
  - It appends the `_id` as UTF-8 **bytes** (tag `0x06`), except for `by_id`.
- The user-index key is therefore `[fields…, _id]`, not `[fields…, _creationTime, _id]`.

`packages/core/src/tx.ts`:

- `insert` generates `_id = crypto.randomUUID()`. Since #4, `_creationTime` comes from the
  transaction's frozen `wallClock()` (an **integer** ms, see `runDeterministic` in `determinism.ts`),
  then `nextUp` for each further insert in the same transaction.
  - Two mutations in the same millisecond get the **same** `_creationTime`. A probe of 20 sequential
    single-insert mutations on the memory driver gave 20 identical `_creationTime` values.
- `IndexRangeBuilder` **ignores the field names** passed to `eq/gt/gte/lt/lte`. It concatenates the
  values in call order. There is no check of index order, of an unknown field, of a duplicate bound,
  or of bounds on two fields.
- There is no index backfill. A new index has no entries for existing documents.

Probe results (memory driver, 20 inserts of `{c: "a", i}` one mutation each):

- `withIndex("by_c", q => q.eq("c","a"))` returned `i` in the order
  `13,4,2,10,11,5,9,8,17,12,0,3,19,7,6,14,18,1,16,15`, which is random UUID order.
- `q.eq("c","a").gt("_creationTime", t)` returned **all 20** documents. The range is compared against
  the `_id` bytes (tag `0x06` is always greater than the number tag `0x04`).
- `q.eq("zzz","a")` on `by_c` returned all 20 documents. Convex fails with `FieldNotInIndex`.

## 4. Divergences

Class:

- **BUG**: bunvex is wrong or unsafe.
- **OBSERVABLE**: apps see a difference.
- **INTERNAL**: not observable.

| # | Divergence | Class | Why / impact | Decision |
|---|---|---|---|---|
| D1 | User indexes do not get `_creationTime` appended. Ties inside equal index values are broken by the random `_id` (`schema.ts` `indexKey`, `Schema.table`) | BUG | The most common Convex pattern (`withIndex("by_x", q => q.eq("x", v))`, e.g. a channel's messages) returns documents in random order instead of creation order | **fixed in #10** (the implicit `_creationTime`; [Phase 0](../parity/README.md#phase-0--correctness-bugs-in-what-already-exists) B5) |
| D2 | `_creationTime` in a range expression is compared against the `_id` bytes and silently matches everything (`tx.ts` `IndexRangeBuilder.range`) | BUG | `q.eq("c", c).gt("_creationTime", t)` is idiomatic in Convex. bunvex returns wrong rows with no error. Follows from D1 and D5 | **fixed in #10** ([Phase 0](../parity/README.md#phase-0--correctness-bugs-in-what-already-exists) B5) |
| D3 | `_creationTime` is an integer ms shared by every mutation that starts in the same ms. Convex uses fractional ms at ns resolution (`engine.ts` `execute`, `determinism.ts` `runDeterministic` → `Math.floor(now)`) | OBSERVABLE | Default (`by_creation_time`) order among documents inserted in the same ms by different mutations is random. The values also look different: no fraction | resolved to match Convex in #10 (DV-33) |
| D4 | A missing field is encoded as `null`, and `eq(f, undefined)` throws (`schema.ts` `indexKey`, `keyenc.ts` `encodeKey`) | BUG | `eq(f, null)` matches documents without `f`, where Convex does not match them. `eq(f, undefined)`, used for "field not set" (common with `v.optional`), crashes | **fixed in #21** ([Phase 0](../parity/README.md#phase-0--correctness-bugs-in-what-already-exists) B6) |
| D5 | `IndexRangeBuilder` ignores field names: no index-order check, and no `FieldNotInIndex`, `InvalidIndexRange`, `AlreadyDefinedBound` or `BoundsOnMultipleFields` errors (`tx.ts`) | BUG | A wrong field or order gives silently wrong results instead of Convex's error | **fixed in #10** ([Phase 0](../parity/README.md#phase-0--correctness-bugs-in-what-already-exists) B5) |
| D6 | Objects, arrays, bytes and bigint are not encodable. Objects all encode to `06 00`, arrays to zeros (`keyenc.ts`) | BUG | Indexing an object or array field gives false equality, wrong ranges and false OCC conflicts. Convex orders them totally | **fixed in #21** ([Phase 0](../parity/README.md#phase-0--correctness-bugs-in-what-already-exists) B11) |
| D7 | Cross-type order differs: bunvex `null < false < true < number < string`; Convex `undefined < null < Int64 < Float64 < boolean < string < bytes < array < object` | OBSERVABLE | Only visible on fields holding several types (booleans and numbers swap places) | resolved to match Convex in #21 (DV-34) |
| D8 | `-0` is normalised to `0` in keys (`keyenc.ts` `pushNumber`); Convex keeps `-0 < 0` | OBSERVABLE | Minor. JSON storage also loses `-0` (STUDY-10) | resolved to match Convex in #21 (DV-34) |
| D9 | Index definitions are not validated: `_`-prefixed and duplicate fields, more than 16 fields, and names `by_id`/`by_creation_time` all accepted; the last one silently replaces the system index in `t.indexes` (`schema.ts`) | OBSERVABLE | A schema Convex rejects is accepted, and `withIndex("by_id")` can then read the user definition | resolved to match Convex in #6, #10 (DV-35) |
| D10 | No nested field paths in indexes (`doc[f]`, `schema.ts`) | OBSERVABLE | `index("by_ab", ["a.b"])` indexes `null` for every document | resolved to match Convex in #21 (DV-36) |
| D11 | No index backfill: an index added to existing data has no entries | BUG | Queries on the new index silently miss old documents. Together with STUDY-01's id-by-declaration-order finding, adding an index can also shift other indexes' ids | **fixed in #6** (STUDY-04) |
| D12 | `_id` in the key is tagged as bytes (`0x06`), not as a string (`0x10`) | INTERNAL | Only the relative order among ids matters, and it is the same | resolved to match Convex in #21 (DV-37) |
| D13 | The shared quirk of the `0x00` escape (both systems): `eq("s", "v")` also matches `"v\u0000…"`, because the prefix `…v 00` is a prefix of `…v 00 FF…` | INTERNAL | Same behaviour as Convex (`BinaryKey::increment`, `End::after_prefix` in `crates/common/src/interval/`). Listed so it is not "fixed" into a divergence | not a divergence: the same in both systems (noted in the [ledger](../parity/divergences.md#resolved-to-match-convex)) |

## 5. Tests

- **Order property:** for random values of every Convex type (undefined, null, bigint, number
  including ±0, NaN and ±Inf, boolean, string with `\u0000`, bytes, nested arrays and objects),
  `compareKeys(encodeKey(a), encodeKey(b))` equals a reference comparator written from §1.1. K1
  should draw from all of these types.
- **Index order:** N inserts with the same indexed value, one per mutation and in the same ms; the
  results come back in insert order.
- **Ranges:** `eq(c).gt("_creationTime", t)` returns exactly the later documents.
- **Range errors:** a wrong field, a wrong order, two lower bounds and bounds on two fields each
  raise Convex's error code.
- **Missing vs null:** `eq(f, undefined)` returns only the documents missing `f`; `eq(f, null)`
  returns only the explicit nulls.
- **Backfill:** add an index over existing data; the query returns every document.
- **Cross-check:** run the same inserts and queries against a Convex deployment and compare the order
  of the `_id`s.

## 6. Open questions

1. Append `_creationTime` exactly as Convex does, or keep `[fields…, _id]` and rely on time-ordered
   ids (STUDY-01 option A)? Only the first matches Convex. It also makes `_creationTime` usable in
   ranges.
2. Should bunvex adopt Convex's tag values and byte layout exactly? Order equivalence is what
   matters. Using the same bytes would allow key-level cross-checks and imports.
3. `_creationTime` resolution: use `performance.timeOrigin + performance.now()` (sub-ms) together
   with the #4 determinism freeze, so that `Date.now()` stays the floor, as Convex's
   `udf_unix_timestamp` does.
