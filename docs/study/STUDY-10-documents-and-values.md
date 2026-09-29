# STUDY-10 — Documents and values: types, field names, limits, insert/patch/replace/delete

- **Status:** draft (retroactive). The code in §3 was written before the study-first rule.
- **Convex source read:** commit `4577b9031` of get-convex/convex-backend
- **bunvex code read:** `main` at `f60e934`
- **Related:**
  - [STUDY-01](STUDY-01-document-ids.md): `_id`.
  - [STUDY-05](STUDY-05-index-keys-and-ordering.md): `_creationTime` and value order.
  - [STUDY-11](STUDY-11-function-results-and-errors.md): values on the wire.
  - ARCHITECTURE `values` (validators are an "N" item).

## 1. How Convex does it

### 1.1 Value types and their JSON encoding

`npm-packages/convex/src/values/value.ts` (`convexToJson` / `jsonToConvex`) and `crates/value`:

| JS value | Convex type | JSON |
|---|---|---|
| `null` | Null | `null` |
| `bigint` in the int64 range | Int64 | `{"$integer": base64 of 8 LE bytes}` |
| `number` | Float64 | a number. NaN, ±Infinity and `-0` ("special", `isSpecial`) go as `{"$float": base64 of 8 LE bytes}` |
| `boolean` | Boolean | `true`/`false` |
| `string` | String | a string |
| `ArrayBuffer` | Bytes | `{"$bytes": base64}` |
| array | Array | an array |
| plain object | Object | an object, with keys **sorted** |

What is rejected, with an error that names the path ("… is not a supported Convex type (present at
path .a[0] …)"):

- `undefined` as a value, including inside an array;
- `Map`, `Set`, `Date`, class instances, functions and symbols;
- a bigint outside the int64 range.

An **object field set to `undefined` is omitted** (`if (v !== undefined)`).

### 1.2 Field names

- **In any object** (`validateObjectField` in `value.ts`; `check_valid_field_name` in
  `crates/convex/sync_types/src/identifier.rs`): at most 1 024 characters, non-control ASCII only,
  and must not start with `$`.
- **At the top level of a document**, `_`-prefixed names are reserved. `ConvexObject::validate` in
  `crates/common/src/document.rs` reports `DocumentValidationError::SystemField` ("invalid system
  field") for any `_` field other than `_id` and `_creationTime`.
- Table names that start with `_` are rejected on insert (`InvalidTableName` in
  `crates/database/src/bootstrap_model/user_facing.rs`).

### 1.3 Limits

| Limit | Value | Source |
|---|---|---|
| Document size | 1 MiB | `MAX_USER_SIZE`, `crates/common/src/document.rs`; error `ValueTooLargeError` |
| Document nesting | 16 levels | `MAX_DOCUMENT_NESTING`; error "too nested" |
| Value nesting | 64 levels | `MAX_NESTING`, `crates/value/src/size.rs` |
| Array length | 8 192 elements | `MAX_ARRAY_LEN`, `crates/value/src/array.rs` |
| Object fields | 1 024 | `MAX_OBJECT_FIELDS`, `crates/value/src/object.rs` |
| System value size | 32 MiB | `MAX_SIZE` |

### 1.4 Documents

- A `ConvexObject` is a `BTreeMap`, so **a document's fields come back in name order** (ASCII:
  uppercase < `_` < lowercase).
- `_creationTime` must be a positive finite float (`CreationTimeInvalidFloat`).
- A document's `_id` must decode to its own table and internal id (`IdMismatch`, `IdWrongTable`).

### 1.5 Writes

`crates/database/src/bootstrap_model/user_facing.rs`, `crates/database/src/transaction.rs` and
`crates/database/src/patch.rs`:

- **`insert(table, value)`:**
  - creates the table if it does not exist;
  - assigns `_id` and `_creationTime`;
  - a `_id` or `_creationTime` in `value` must match what is assigned, otherwise `PendingDocument::new`
    rejects it ("Provided creation time … doesn't match").
- **`patch(id, value)`:**
  - is a **shallow merge**; a field sent as `undefined` (`{"$undefined": null}` from
    `patchValueToJson`) is **removed**;
  - the result is validated again, so changing `_id` or `_creationTime` fails;
  - a missing document gives `NonexistentDocument`: "Update on nonexistent document ID {id}".
- **`replace(id, value)`:** replaces the whole body and keeps `_id` and `_creationTime`. A missing
  document gives "Replace on nonexistent document ID {id}".
- **`delete(id)`:** a missing document gives "Delete on nonexistent document ID {id}".
- **System tables** are read-only to user code ("System tables (prefixed with `_`) are read-only.",
  `database_impl.ts`).
- The value is **serialized when the syscall is made** (`convexToJson`), so the caller mutating its
  object afterwards has no effect.

## 2. What an app can observe

1. `bigint`, `ArrayBuffer`, NaN, ±Infinity and `-0` round-trip exactly.
2. Unsupported values (Date, Map, Set, class instances, `undefined` in arrays) raise an error at the
   write.
3. Invalid field names, and top-level `_` fields, raise an error.
4. Size, nesting, array-length and field-count limits raise named errors.
5. `patch` with `undefined` removes the field, also as seen by later reads in the same mutation.
6. `patch`, `replace` and `delete` on a missing document throw.
7. Documents read back have their fields in sorted order.

## 3. How bunvex does it today

`packages/core/src/tx.ts`:

- **Storage:** documents are stored with `JSON.stringify` at commit time (`toWrites`) and read with
  `JSON.parse`. There is no Convex value layer.
  - Probe: inserting
    `{x: NaN, y: Infinity, z: -0, arr: [1, undefined], d: new Date(0)}` stored
    `{"x":null,"y":null,"z":0,"arr":[1,null],"d":"1970-01-01T00:00:00.000Z"}`. There was **no
    error**, and the values were silently changed.
  - Its `by_x` index entry was computed from the in-memory value (NaN), so the index says NaN and the
    document says `null`.
  - `bigint` makes `JSON.stringify` throw at commit ("JSON.stringify cannot serialize BigInt").
    `ArrayBuffer` becomes `{}`; `Uint8Array` becomes an object keyed `"0"…`.
- **`insert`:** `{ ...fields, _id, _creationTime }`.
  - A caller-provided `_id`/`_creationTime` is silently overwritten.
  - Any field name is accepted. Probe: `{_secret, $bad, é}` was stored as is.
  - The copy is **shallow**, and the object is serialized only at commit. Probe: pushing into an
    array after `insert`, and assigning to the object `db.get` returned inside the same mutation,
    both reached the stored document **and** its index keys, with no `patch`.
- **`patch`:**
  - is a shallow merge, as in Convex;
  - `_id`/`_creationTime` in the patch are silently ignored;
  - a missing document throws `patch: T/ID not found`;
  - a field set to `undefined` is dropped by `JSON.stringify` at commit, so it is removed after the
    commit. Probe: **within the same mutation**, `"f" in doc` is still `true` (the value is
    `undefined`).
- **`delete`:** a missing document returns silently.
- **`replace`:** does not exist.
- There are no limits (size, nesting, array length, field count), no system-table protection and no
  table-name rules.
- Documents keep insertion field order, with `_id` and `_creationTime` last.

## 4. Divergences

| # | Divergence | Class | Why / impact | Decision |
|---|---|---|---|---|
| D1 | NaN, ±Infinity, `-0`, `undefined` in arrays and `Date` are silently changed by `JSON.stringify` (to `null`, `0`, an ISO string) | BUG | Silent data corruption. The index entry is computed before serialization, so the index and the document disagree (NaN in the key, `null` in the document) | owner |
| D2 | No Int64 (`bigint`) or Bytes (`ArrayBuffer`): bigint throws at commit, bytes become `{}` | OBSERVABLE | Two of Convex's value types are missing, and the bytes case silently loses data | owner |
| D3 | Written values are not copied or serialized at the call: later caller mutations, and mutations of a `db.get` result for a document written in the same transaction, reach the commit (`tx.ts` `insert`/`get`/`stage`) | BUG | A write without `patch`; and the pending read-own-writes index (built at `stage`) no longer matches the keys `toWrites` computes at commit | owner |
| D4 | No field-name validation: `$`-prefixed, non-ASCII, over 1 024 chars, and top-level `_` fields all accepted | OBSERVABLE | Data Convex rejects is stored, and cannot be exported or imported into Convex | owner |
| D5 | `_id`/`_creationTime` in `insert`/`patch` are silently overwritten or ignored; Convex rejects a mismatch | OBSERVABLE | An error in Convex, silence in bunvex | owner |
| D6 | No document limits (1 MiB, nesting 16, array 8 192, 1 024 fields) | OBSERVABLE | Code that works on bunvex fails on Convex. Unbounded documents also stress the stores (MySQL `mediumtext` 16 MiB) | owner |
| D7 | `delete` of a missing document is a silent no-op; Convex throws "Delete on nonexistent document ID" | OBSERVABLE | Different control flow | owner |
| D8 | `patch` error message differs ("patch: T/ID not found" vs "Update on nonexistent document ID {id}") | OBSERVABLE | Message and code differ | owner |
| D9 | No `replace` | OBSERVABLE | Missing API | owner |
| D10 | `patch({f: undefined})`: inside the same mutation the field is still present with the value `undefined` | OBSERVABLE | `"f" in doc` / `Object.keys` differ within the mutation (after commit it matches) | owner |
| D11 | Field order: insertion order with `_id`/`_creationTime` last, vs Convex's sorted order | OBSERVABLE | Visible in `Object.keys`, `JSON.stringify` and snapshot tests | owner |
| D12 | No table-name rules and no read-only system tables | OBSERVABLE | Relevant once system tables (`_storage`, `_scheduled_functions`) exist | owner |

## 5. Tests

- **Round trip:** every type in §1.1, including NaN (both signs), ±Infinity, `-0`, the int64
  extremes, empty and non-empty bytes, and deep nesting, through insert → get on every driver, and
  through the HTTP/WS wire (STUDY-11).
- **Rejections:** each value, field name and limit in §1.2–§1.3 raises Convex's error text.
- **Isolation:** mutating the argument object after `insert`/`patch`, or a returned document, never
  changes what is stored.
- **Missing documents:** `patch`, `replace` and `delete` on one throw Convex's messages.
- **Cross-check:** a document exported from Convex (snapshot export) imports into bunvex and reads
  back byte-identical after `convexToJson`.

## 6. Open questions

1. Store documents as Convex's JSON encoding (`$integer`/`$float`/`$bytes`) inside the existing
   `json_value` text, or as a binary encoding? The first keeps drivers unchanged and matches
   Convex's `ConvexEncodedJSON`.
2. Where does value validation live? It should be in `@bunvex/values`, shared by `convexToJson` on the
   client and the server; the engine calls it on every write.
