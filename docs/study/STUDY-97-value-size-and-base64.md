# STUDY-97 — `getDocumentSize`, `Base64` and `getConvexSize`

- **Status:** implemented; the `getConvexSize` name decided by the owner (2026-10-04, DV-347)
- **Convex source read:** `main` of get-convex/convex-backend (4577b9031), 2026-10-04
- **Related:** [STUDY-18](STUDY-18-value-model.md) (the value model), [STUDY-68](STUDY-68-function-limits.md)
  (`valueSize` for the limits)

## 1. How Convex does it

`convex/values` exports three utilities, all public, from `npm-packages/convex/src/values/index.ts`.

**`getConvexSize(value)`** is in `size.ts`. It matches the Rust `Size::size` of `crates/value`:

| Value | Size |
|---|---|
| `undefined` | 0 |
| `null`, a boolean | 1 |
| a number, a bigint, a `CommitTsPlaceholder` | 9 |
| a string | its UTF-8 bytes + 2 |
| an `ArrayBuffer` | its bytes + 2 |
| an array | 2 + its elements' sizes |
| a plain object | 2 + Σ(key's UTF-8 bytes + 1 + the value's size), `undefined` fields skipped |

Anything else throws `Unsupported value type: ${typeof value}`.

**`getDocumentSize(value, { customIdLength? })`** adds the system fields a document will have, to what
`getConvexSize` gives. A field counts as missing when it is absent or `undefined`:

- a missing `_id` adds 38 (`SYSTEM_FIELD_ID_ESTIMATE`, a 32-character id), or `customIdLength + 6` when that
  option is set (`@internal`; 0 counts as not set);
- a missing `_creationTime` adds 23.

**`Base64`** is the namespace from `base64.ts`, a vendored base64-js. It has four functions:

- `byteLength(b64)` and `toByteArray(b64)` decode. They accept standard and URL-safe characters.
  - The length must be a multiple of 4, else "Invalid string. Length must be a multiple of 4".
  - Everything after the first `=` is ignored.
  - A character outside the alphabet decodes as 0 bits.
- `fromByteArray(bytes)` gives padded standard base64.
- `fromByteArrayUrlSafeNoPadding(bytes)` gives URL-safe base64 without padding.

## 2. What an app can observe

- The names: `import { getDocumentSize, Base64 } from "convex/values"`.
- The numbers and strings above, including `Base64`'s and `getConvexSize`'s errors.

## 3. How bunvex does it

- **`getDocumentSize`** is in `@bunvex/values` `value.ts`, next to `valueSize`.
- **`valueSize`** is bunvex's `getConvexSize`. It already gave the same sizes for values, and now has
  Convex's edges too: `undefined` is 0, a commit-ts placeholder 9, and anything else throws Convex's message.
- **`rawValueSize`** is the same walk without the throw, where a class instance or function counts as an
  object. The engine and server use it to measure arguments, results and writes for the limits before
  validating them: the strict version threw first and hid each value's own error ("… is not a supported
  value type (present at path …)").
  A fast path for plain objects keeps the walk as fast as before: 274 ns against 291 ns on main for a small
  nested document.
- **`Base64`** is the `base64.ts` namespace, written for bunvex with base64-js's results and errors.

Everything is re-exported by `bunvex/values`.

The results were checked against Convex's own functions over 20 000 random cases: byte arrays, random strings
of base64 and other characters, values and documents. Every result and every error message matches, with
one exception: the length a malformed string such as `=y+C` decodes to is negative, and the engine's text
for that `RangeError` differs (it is the engine's, not Convex's).

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| VS1 | `getConvexSize` is `valueSize`: an `import { getConvexSize }` fails | Rule 5: no "convex" in shipped names, as `toJsonValue` for `convexToJson` | owner, 2026-10-04: keep `valueSize` (DV-347) |

## 5. Tests

`packages/values/test/size-base64.test.ts`:

- `valueSize`'s sizes and edges, and its errors;
- `rawValueSize` on non-values;
- `getDocumentSize` with each system field present or not, and `customIdLength`;
- `Base64`:
  - encoding padded and URL-safe;
  - decoding both alphabets;
  - the length error;
  - characters outside the alphabet;
  - the text after `=`;
  - a round trip of every length to 63, against Node's encoder.

Sabotage checks, each caught:

- `undefined` not 0;
- the placeholder not 9;
- an unsupported object accepted;
- each estimate changed (`_id`, `_creationTime`, `customIdLength` + 6);
- the URL-safe characters not decoded;
- no length check;
- the URL-safe encoding padded;
- the server's result size measured with the strict `valueSize`: `nested-results` and `unsupported-value-leak`
  fail.

## 6. Open questions

None.
