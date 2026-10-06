# STUDY-135 — Strings with a lone surrogate, refused where Convex refuses them

- **Status:** implemented (STUDY-122 D3 decided A; Q1 B, DV-431; Q2 A; owner, 2026-10-06)
- **Convex source read:** commit `4577b903` of get-convex/convex-backend; `serde_json` 1.0.151 (its `Cargo.lock`)
- **Related:** [STUDY-122](STUDY-122-differential-testing.md) (D3: the differential tests found it),
  [STUDY-20](STUDY-20-function-errors-and-logs.md), [STUDY-41](STUDY-41-nested-calls-and-execution-limit.md)

A JavaScript string may hold a lone surrogate: a UTF-16 unit from `\ud800` to `\udfff` with no partner,
such as `"\ud800"`. Rust strings cannot hold one. Convex moves values between its JS runtime and Rust as
JSON text, so a lone surrogate fails wherever a value crosses. bunvex is all JavaScript, so it stored and
returned these strings everywhere.

## 1. How Convex does it

### 1.1 The crossing

- **The JS side.** Syscall arguments and results are sent as `JSON.stringify` text. Since ES2019 it escapes a
  lone surrogate as `\udXXX` in ASCII, so the text itself is valid.
- **The Rust side** (`crates/isolate/src/execution_scope.rs` `syscall` / `async_syscall`):
  - `serde_json::from_str` parses that text, and refuses the escape.
  - The error is `ErrorMetadata::bad_request("SyscallArgsInvalidJson", "Received invalid json: {e}")`. A function
    can catch it like any other syscall error.
- **serde_json's two messages**, read in its escape parser and confirmed against the binary:
  - A high surrogate (`\ud800`–`\udbff`) not followed by `\u`: "unexpected end of hex escape". The column is
    the character after the six-character escape.
  - A low surrogate (`\udc00`–`\udfff`) first, or a high one followed by a `\u` escape that is not a low
    surrogate: "lone leading surrogate in hex escape". The column is the last hex digit of the offending
    escape.
  - A valid pair (`😀`) parses.
  - serde reports `at line 1 column N`, counted in the syscall's JSON text, 1-based.
- **Raw strings** (`to_rust_string`, `crates/isolate/src/helpers.rs`): converting a V8 string to Rust does not
  replace bad UTF-8 ("we want unpaired surrogates to fail"). Logs and error messages instead go through a
  lossy conversion, and a lone surrogate there becomes U+FFFD.

### 1.2 Each path, measured on Convex's local backend

All with `H = "\ud800"` and `L = "\udc00"`.

| Path | Convex |
|---|---|
| `db.insert("a", {k: H})` | caught: "Received invalid json: unexpected end of hex escape at line 1 column 34" (`{"table":"a","value":{"k":"\ud800"}}`) |
| `db.insert` with `L`, `H + H`, `L + H` | "lone leading surrogate in hex escape at line 1 column 33 / 39 / 33" |
| `db.insert` nested (`{x: 1, y: {z: [1, H]}}`), `` `a${H}b` `` | the same message, the column moved |
| `db.patch(id, {k: H})`, `db.replace(id, {k: H})` | "unexpected end of hex escape at line 1 column 62" (`{"id":"<32>","value":{…}}`) |
| `withIndex("by_k", q => q.eq("k", H))`, `.filter(q => q.eq(q.field("k"), H))` | the same, column 115 / 139 (the query's JSON) |
| `ctx.runQuery` / `ctx.runMutation` with `{s: H}`, from a mutation and from an action | the same, column 39 / 42 / 42 |
| `ctx.scheduler.runAfter(0, ref, {s: H})` | the same, column 62 |
| A field name with a lone surrogate | refused in JS first (`validateObjectField`, already matched) |
| A query, mutation or action returning `H` | the request fails: "Function probe.js:ret failed. Could not parse return value as json: unexpected end of hex escape at line 1 column 8" (`crates/isolate/src/helpers.rs`) |
| Arguments from a client (`/api/query`, args `{"s":"\ud800"}`) | "Invalid arguments provided" (`crates/value/src/serialized_args_ext.rs`) |
| `console.log(\`log ${H} line\`)` | logged as "log � line" |
| `throw new Error(\`boom ${H}\`)` | "Uncaught Error: boom �" |
| `throw new ConvexError(H)` | **InternalServerError**: "Your request couldn't be completed. Try again later." (the data fails to parse, `deserialize_udf_custom_error`, and the `?` turns it into a system error) |
| `throw new ConvexError({k: H})` | "Uncaught ConvexError: {"k":"\ud800"}" (the message is ASCII JSON), **with no `errorData`** |

## 2. What apps observe

- A write, query, nested call or scheduled call that carries a lone surrogate fails with a catchable error.
  Its message, "Received invalid json: … at line 1 column N", is all an app can match.
- A function that returns one fails as a whole.
- A client that sends one gets "Invalid arguments provided".
- Logs and error messages show U+FFFD in its place.
- A `ConvexError` whose data holds one is a system error (string data) or loses its data (object data).
- No lone surrogate is ever stored or returned.

## 3. How bunvex will do it

- **One scanner:** `firstLoneSurrogate(json)` in `@bunvex/values` reads JSON text as serde does. It returns
  serde's message and column for the first refused escape, or nothing.
- **Syscall arguments.** Each operation measures the JSON text Convex's JS sends for it, rebuilt with the same
  shape and key order (`{"table","value"}` for `db.insert`, `{"id","value"}` for `patch` / `replace`, the
  query's serialized form for `withIndex` / `filter`, the `runUdf` and scheduler argument objects). These
  shapes are read in `npm-packages/convex/src/server/impl/*.ts` and pinned by tests against the columns
  above. The text is built only when a value holds a lone surrogate: a check on each written string finds
  it first, so the common path pays a scan and nothing else.
- **Return values:** "Function <path> failed. Could not parse return value as json: …", with the column in
  `JSON.stringify` of the returned value.
- **Client arguments:** "Invalid arguments provided" (HTTP, and the sync protocol once probed; see §6).
- **Logs and error messages:** `String.prototype.toWellFormed()` gives U+FFFD, as Convex's lossy conversion.
- **Tests:**
  - Each row of §1.2 is a test, with the exact message.
  - The differential app's `limit` case 8 joins `LIMIT_CASES`.
  - A probe module, like this study's, runs every path against Convex in the differential tests.
- **Measurement:** the string scan on writes and returns, before and after, on a write-heavy benchmark.

## 4. Divergences

| # | Question | Options | Recommendation |
|---|---|---|---|
| **Q1** — decided: **B** (owner, 2026-10-06; DV-431) | `throw new ConvexError(H)` (string data with a lone surrogate) is a system error on Convex: InternalServerError, and the client retries. | **A.** Match it: a system error. **B.** A function error carrying "Uncaught BunvexError: �" with no data (a divergence). | **B**: Convex's answer comes from a `?` on a parse failure, not a decision, and it makes a client retry a call that fails the same way each time. |
| **Q2** — decided: **A** (owner, 2026-10-06) | `throw new ConvexError({k: H})` (object data) keeps its message and loses `errorData` on Convex. | **A.** Match it: the message, no data. **B.** Keep the data with U+FFFD in place of the surrogate (a divergence). | **A**: the error still reaches the app as a function error, and the missing data is what apps observe. |

## 5. Additions

None.

## 5b. Built

- **`@bunvex/values`:** `jsonSurrogateError` (serde_json 1.0.151's `parse_unicode_escape`; columns in bytes,
  one byte taken past a lone high surrogate) and `refuseLoneSurrogates`.
- **`core/tx.ts`:** `db.insert` / `patch` / `replace` and `queryStream` / `queryPage`, with Convex's texts.
- **`server`:** nested calls, an action's calls, the scheduler, results (`checkReturns`), client arguments
  (`checkArgs`), log lines (`makeLogLine`), and messages and data (`describeUncaught`).
- **Tests:**
  - `values/test/surrogates.test.ts`, `core/test/lone-surrogates.test.ts` and
    `server/test/lone-surrogates.test.ts`.
  - The differential program "lone surrogates along each path" (`app/surrogates.ts`) gives the same answer on
    Convex for every case.
  - The `limit` op's case 8 is compared again.
- **Measurement** (500 inserts of 10-string documents, and a 500-document result, median of 9 runs, three
  rounds):

  | | `main` | With this |
  |---|---|---|
  | 500 inserts | 9.1–9.6 ms | 9.1–9.9 ms |
  | A 500-document result | 0.59–0.60 ms | 0.59–0.61 ms |

## 6. Open points to probe while building

- **The sync protocol.** A WebSocket client message whose arguments hold a lone surrogate. On Convex it may be
  "Invalid arguments provided" or a closed connection.
- **The other syscalls** that carry user values: `vectorSearch`, `storage` metadata, `createFunctionHandle`,
  pagination cursors. Each is one probe and one test.
