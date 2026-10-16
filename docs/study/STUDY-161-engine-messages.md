# STUDY-161 — Engine messages found with the dashboard

- **Status:** decided (owner, 2026-10-15: match Convex on the differences STUDY-149 PR 3 found); one PR per
  concern (§1–§7, each section's *Built* line); §8 accepted as a divergence (owner, 2026-10-15: Q1 (a), DV-520); §15's words accepted as a divergence (owner,
  2026-10-15: (b), DV-529)
- **Convex source read:** commit `d8bdde0` of get-convex/convex-backend (`crates/isolate/src/environment/udf/
  async_syscall.rs`, `udf/syscall.rs`, `crates/convex/sync_types/src/identifier.rs`, `crates/value/src/
  table_name.rs`, `crates/common/src/types/index.rs`, `crates/common/src/schemas/mod.rs`, `crates/common/src/
  document.rs`, `crates/indexing/src/index_registry.rs`, `crates/udf/src/validation.rs`, `crates/database/src/
  bootstrap_model/index.rs`, `bootstrap_model/schema/mod.rs`, `crates/model/src/components/config.rs`,
  `crates/isolate/src/environment/analyze.rs`, `npm-packages/convex/src/server/impl/database_impl.ts`,
  `npm-packages/convex/src/values/value.ts`); every message below checked against the binary of the same release
  (`precompiled-2026-10-07-d8bdde0`)
- **Related:** STUDY-149 ("PR 3, as built": found on the way, items 1–7; "PR 5": the analyzed line, §8),
  STUDY-14, STUDY-16, STUDY-35, STUDY-65 M5, STUDY-95 S2 (DV-346), STUDY-150 (frames)

The dashboard's oracle tests (STUDY-149) masked differences that every function shares: the words of `db.insert`'s
argument errors, the schema error's display, a system-field mismatch's display, a query on a table or index that
does not exist, a `$` field in a system function's arguments, the table numbers a push gives, and the line the push
analysis records for a function. Each section is how Convex does it, bunvex before, bunvex's design and how it is
tested. The frames after a message (`at async handler` on Convex, `at <anonymous>` on bunvex) are STUDY-150's and
DV-345's, not this study's.

## 1. `db.insert`'s table: an identifier, in Convex's words

**Convex.** `database_impl.ts:96-108` refuses a `_` name first ("System tables (prefixed with `_`) are read-only."),
then `validateArg` checks that `table` and `value` were given, then the value is serialized (`convexToJson`) and the
`1.0/insert` syscall parses its arguments under `with_argument_error("db.insert", …)` (`async_syscall.rs:1346-1366`):
the value first (§2), then `table.parse::<TableName>()` with `ArgName("table")`. `TableName::from_str`
(`table_name.rs:55-61`) is `check_valid_identifier` (`identifier.rs:105-140`), whose message is the error:

- `Identifier cannot be empty`;
- ``Invalid first character '9' in 9lives: Identifiers must start with an alphabetic character or underscore``;
- ``Identifier a-b has invalid character '-': Identifiers can only contain alphanumeric characters or underscores``;
- `Identifier is too long (65 > maximum 64)` (UTF-8 bytes, checked after the characters);
- `Identifier __ cannot have exclusively underscores` (not reachable from `db.insert`: `_` is refused first).

The character is Rust's `{:?}` of a `char` (`char::escape_debug`): `'\n'`, `'\t'`, `'\''`, `'\\'`, `'"'` as is, and
`\u{…}` for a character Rust does not print (controls, format characters such as U+200B or U+00AD, separators such as
U+00A0 or U+2028, combining marks such as U+0301); a printable one as is (`'é'`, `'😀'`). The app sees
``Uncaught Error: Invalid argument `table` for `db.insert`: <message>``. `db.table(name).insert(…)` is the same call.
`db.count` (STUDY-107) words it ``Invalid argument `table` for `db.count`: <message>`` from the same check.

**bunvex before.** `checkIdentifier("table", …)` (`core/src/schema.ts`), at the table's creation: ``Invalid table name
"9lives": use at most 64 ASCII letters, digits and underscores, starting with a letter or underscore.``, under no
argument prefix; `db.count` put that message under its prefix.

**bunvex now.** The identifier check in Convex's words and order, with Rust's character display, shared by the
engine and the server (`function-path.ts` already had it for paths); `db.insert` and `db.count` prefix it as Convex.
Schema definitions keep their own push-time words (Convex checks those in its CLI and its schema parser, STUDY-14).

## 2. `db.insert` / `db.patch` / `db.replace`'s value: Convex's argument errors

**Convex.** In the JS layer, a missing value is ``TypeError: Must provide arg 2 `value` to `insert` `` (`patch`,
`replace` the same, `validateArg`). The syscall then parses the value (`PendingValue::from_uncommitted_json` with
`ArgName("value")`), and refuses one that is not an object (`async_syscall.rs:1360`, `:1454`; `patch.rs:60` for a
patch): ``Error: Invalid argument `value` for `db.insert`: Value must be an Object`` for a number, a string, an
array, `null` or a boolean. A value nested past 64 levels is refused by that parse, so under the same prefix:
``Invalid argument `value` for `db.insert`: Value is too nested (nested 65 levels deep > maximum nesting 64)``. The
value is checked before the table: `db.insert("9x", 1)` says "Value must be an Object".

**bunvex before.** ``TypeError: Invalid argument `value` for `db.insert`: expected an object`` (`copyFields` in
`core/src/tx.ts`); a missing value the same, and `db.patch(id)` / `db.patch(id, null)` a JavaScriptCore `TypeError`
(`Object.entries requires …`); the nesting error without the prefix.

**bunvex now.** Convex's three: the missing argument (`TypeError`, as `validateArg`), the plain `Error` "Value must be
an Object" under the argument prefix, and the nesting error under it, for the three writes. A top-level value that is
not a value at all (a function) keeps the serializer's own error, which Convex's JS layer gives first.

## 3. A schema error's document and validator, without the system fields

**Convex.** `DocumentSchema::check_value` (`schemas/mod.rs:661-680`) checks the table's validator against the document
*with its system fields removed* (`ConvexObject::filter_system_fields`, `value/src/object.rs:193`: every top-level
field starting with `_`); the validator is the schema's, which never names them. So a missing field shows
``Object: {}`` and ``Validator: v.object({n: v.optional(v.float64()), name: v.string()})``, an extra field
``Object: {extra: 1.0, name: "a"}``. The same check serves a write, a pending schema's validation of a write and a
push's walk of the existing documents.

**bunvex before.** `documentValidator` (`core/src/schema.ts`) added `_id: v.id(table)` and
`_creationTime: v.number()` to each object of the validator and checked the whole document, so both displays carried
them (`Object: {_creationTime: 1792067806077.0, _id: "…"}`, `Validator: v.object({_creationTime: v.float64(), _id:
v.id("strict"), …})`). A wrong value's error (`Path: .name`) already matched.

**bunvex now.** The validator is the schema's own, checked against the document without its top-level `_` fields,
everywhere `documentValidator` serves (writes, pending and staged validators, the push's walk).

## 4. A system-field mismatch's display

**Convex.** `ResolvedDocument::new` (`common/src/document.rs:386-421`) checks the written value's `_id`, then its
`_creationTime`. The `_id` message displays the field as a value (``doesn't match '_id' field 1.0``, a string quoted);
the creation time message displays the whole value being written, the `_id` added: for an insert the value, for a
replace the new value, for a patch the merged document (``Provided creation time 1792067806145.067 doesn't match
'_creationTime' field in {_creationTime: 1.0, _id: "jh77…", name: "x"}``), in Convex's display (fields sorted, floats
with `.0`, bytes as `b"…"`, an int64 bare).

**bunvex before.** `checkSystemFieldValues` (`core/src/tx.ts`) printed the written fields as JSON
(`{"_creationTime":1}`), the patch's fields only; an int64 `_creationTime` threw JavaScriptCore's `JSON.stringify
cannot serialize BigInt.`; bytes printed `{}`; the `_id` field as JSON (`1`, not `1.0`).

**bunvex now.** Both messages in Convex's display, of the value Convex displays (the insert's or replacement's value,
or the merged patch, each with its `_id`). STUDY-149 also noted server frames on this error; STUDY-150 removed them
(checked again: none on main).

## 5. A query's table and index: what does not exist, and names that are not identifiers

**Convex.** A query is parsed by its syscall (`queryStream`, `udf/syscall.rs:232-240`; `queryPage`,
`async_syscall.rs:1961-1964`) under ``Invalid argument `query` for `<syscall>` ``: a full scan's table parses as a
`TableName` (§1's messages); an index's `table.index` name parses as an `IndexName` (`types/index.rs:159-178`), whose
errors are `index_validation_error`'s: ``Invalid table name: "9x". Identifiers must start with a letter and can only
contain letters, digits, and underscores.`` for a bad table **and** for a bad index descriptor (the descriptor's
error is wrapped in `invalid_table_name` too), `Too many components in index name free.a.b`. Then the index is looked
up: one that does not exist is ``Index nope.by_creation_time not found.`` (`index_registry.rs:870`,
`IndexNotFoundError`) — for a table that does not exist even `by_id` and `by_creation_time` (they exist only with the
table), and for a search index the same. A full scan of a table that does not exist is empty, as is `count`.

**bunvex before.** An index on a table that does not exist answered nothing (`withIndex`, `withSearchIndex`,
`paginate`); an index the table lacks was ``unknown index free.nope``; names were not checked (`db.query("9x")`
answered nothing, `withIndex("a.b")` was "unknown index").

**bunvex now.** Convex's parse and lookup at the query's start (`queryStream` for a stream and a search,
`queryPage` for `paginate`): the names' errors under the prefix, then ``Index <table>.<index> not found.``. A
missing table's error still depends on `_tables`, so a subscription runs again when the table is created.

## 6. A `$` field (or any argument Convex's parse refuses) in a system function's arguments

**Convex.** `ValidatedPathAndArgs::new_with_returns_validator` (`udf/validation.rs:499-541`) skips everything but
the identity check for a `_system/` path: the arguments stay JSON (`SerializedArgs`) and are first read by the system
function's JS wrapper, `jsonToConvex` (`values/value.ts:202-215`). A `$x` field is then the function's own error:
``Uncaught Error: Field name $x starts with a '$', which is reserved.`` (JS's words, "a '$'"), after the access check
(a non-admin still gets the 403 `SystemIdentityRequired`). A user function's arguments are parsed before the run
(`parse_udf_args`, `udf/src/helpers.rs:35-49`): ``Invalid arguments for probe.js:echo: Field name $x starts with '$',
which is reserved.`` (Rust's words), which bunvex matched already.

**bunvex before.** Every path's arguments were parsed before the run (`fromWire`, `server/src/server.ts`): a system
function's `$x` was ``Invalid arguments for _system/frontend/addDocument.js:default: Field name $x starts with '$',
which is reserved.``, a request error before the access check.

**bunvex now.** A `_system/` path's arguments that do not parse are handed to the function as unparsed, and the
system function refuses them where Convex's does, after the access check and before its own argument check, as
``Uncaught Error: <the JS parser's message>`` with no frames (the system modules show none, as `systemArgs`' errors).

## 7. The table numbers a push gives new tables

**Convex.** A push's start (`components/config.rs:313-322`) first prepares the indexes
(`prepare_new_and_mutated_indexes`, `bootstrap_model/index.rs:657-700`): the added indexes in `IndexName` order
(`indexes_in_new_schema` builds a `BTreeMap`, `:575-660`), each `_add_index` creating its table if it does not exist
(`:150-160`). Then `submit_pending` (`schema/mod.rs:265-272`) creates the schema's remaining tables in `BTreeMap`
order. So the new tables that have an index (database, staged, text or vector) take the next numbers in name order
(byte order: `Mango` before `apple`), then the others in name order. Seen on the binary: a schema declaring `zebra`,
`strict`, `free` (indexed), `apple`, `Mango` numbers them `free` 10001, `Mango` 10002, `apple` 10003, `strict`
10004, `zebra` 10005.

**bunvex before.** Declaration order (`zebra` 10001, `strict` 10002, `free` 10003, …).

**bunvex now.** The push declares the schema's tables to the catalog in Convex's order (indexed first, each group by
name); the numbers of tables that exist are untouched.

## 8. The line the push analysis records for a function (Q1: accepted, DV-520)

**Convex.** `udf_analyze` (`analyze.rs:681-722`) takes the handler's V8 start in the *bundled* module, adds 1 to the
0-based line and column, passes them to the 0-based `lookup_token`, and records the token's 0-based original line
(STUDY-65 M5). The result depends on how esbuild printed the module: with the CLI's `minifySyntax` and `keepNames`,
`messages:secret` of `functions-app/messages.ts` (handler on line 35) is followed on its next bundled line by
`}), loose = …, act = actionGeneric({`, whose token maps to line 39 (0-based) — Convex's dashboard shows 39.

**bunvex.** The same arithmetic (`server/src/source-position.ts`) over Bun.build's output, which prints the same
source differently: 37. Most functions agree because both bundlers keep one statement per line; a short handler
followed by a declaration esbuild joins with a comma does not.

**Why it is not matched here.** The number is an artifact of esbuild's printer under Convex's off-by-one lookup. bunvex
cannot reproduce it without esbuild's exact output, so this is a choice for the owner (Q1), not a fix.

*Built:* nothing to build: the owner accepted (a) (2026-10-15, DV-520).

## 9. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| Q1 (DV-520) | The line a function is listed at in the dashboard's Functions tree (`modules:listForAllComponents`'s `lineno`, the order of a file's functions) can differ from Convex's for the same source | Convex's number comes from esbuild's printed bundle under an off-by-one lookup; bunvex bundles with Bun.build | **accepted, (a)** (owner, 2026-10-15) |
| §15 (DV-529) | The words of the error for a streamed HTTP action body's chunk that is not bytes: bunvex's own, with v8's type names, where Convex gives serde_v8's | serde_v8 is a library bunvex does not use | **accepted, (b)** (owner, 2026-10-15) |

**Q1 — the analyzed line of a function.**

- *Convex:* the token after the handler's bundled position, per esbuild's printing (§8): usually the handler's line,
  sometimes a neighbouring or blank line.
- *bunvex:* the same arithmetic over Bun.build's printing: the same line in most cases, another in some (37 against
  39 in the oracle's app).
- *Same?* No, in a minority of functions.
- *Why:* "Não dá pra fazer" with Bun.build: the number is esbuild's printer's. Matching it means bundling with esbuild
  in the CLI.
- *App impact:* none on an app; the dashboard's Functions tree shows another line next to a function, and may order
  two functions of a file differently.
- *Options:* (a) accept: keep Convex's arithmetic over Bun's output (today). (b) report the handler's real line
  (the token at the handler's own position): right more often than Convex, never Convex's quirk. (c) bundle with
  esbuild in the CLI (a new dependency and a second bundler path, against STUDY-35's choice of Bun.build).
- *Recommendation:* (a): no app observes it, and (c) costs a bundler for a dashboard number.
- *Decision:* (a), accepted by the owner (2026-10-15); DV-520 in [divergences.md](../parity/divergences.md).

## 10. Tests

Each section's PR: unit tests next to the code it changes (`core/test`, `server/test`), the differential test's mask
for the item removed (`differential/test/dashboard-writes.test.ts`, `dashboard-functions.test.ts`), and a
differential test of the messages on both backends where the oracle can show them. Each PR breaks its fix a few ways
and lists what failed in its *Built* line.

## 11. Open questions

None: Q1 (§8) was decided by the owner (2026-10-15: (a), DV-520).

## 12. As built

### §1 and §2 (`db.insert` / `db.patch` / `db.replace` argument errors)

*Built* (#666): `identifierError` and `rustDebugChar` in `@bunvex/values` (`identifier.ts`), shared by the engine and the
server's path and validator parsers (their two partial copies of Rust's character display removed); `Tx.insert`,
`patch`, `replace` and `count` in `core/src/tx.ts`. Found while building it: a pushed module's objects are its
context's (another realm), so `extractCommitTs` took a deployed function's value for a leaf: its nesting error lost
the argument prefix (the copy's own check spoke), and a `db.vars.commitTs` inside such an object was not found. It now
recognizes a plain object of any realm. Convex's `TypeError` for a top-level function value (its serializer fails in
`stringifyValueForError`) is not matched: bunvex keeps its unsupported-value message (DV-316's wording).
Tests: `values/test/identifier.test.ts` (each rule, 17 characters checked against the binary),
`core/test/write-argument-errors.test.ts` (the messages, their classes and order, `db.table`, `db.count`, a value of
another realm); `differential/test/write-errors.test.ts` (21 table names, 5 non-object values per write, nesting,
missing values, on both backends); the old messages' assertions updated (`count`, `implicit-tables`,
`tx-d-edges`). Sabotage (each restored, `git diff` clean): no table check (the table test fails); Rust's `\u{…}`
escapes dropped (2 tests); the old "expected an object" (1); the realm check reverted (the realm test); no
missing-value check (1); a patch's object check after its parse (1); the table checked before the value (2).

### §3 (the schema error's display)

*Built* (#668): `documentValidator` (`core/src/schema.ts`) is the schema's own validator, and `checkDocument` checks a
document without its top-level `_` fields; the five places a document meets its table's validator use it (a write,
the pending and staged validators in `tx.ts`; the push's walk and the staged walk in `engine.ts`). Tests:
`core/test/schema-error-display.test.ts` (missing and extra fields by insert, patch and replace, a wrong value, a
union, a push's walk); `differential/test/schema-errors.test.ts` (11 writes on both backends, the display without
`_creationTime` asserted on Convex's side); `tx-d-edges`' pending-validator test now gives the schema's validator.
Sabotage (each restored, `git diff` clean): the system fields kept in the document (5 tests fail), only `_id` left
out (5), the old validator with the system fields added (3).

### §4 (the system-field mismatch's display)

*Built* (#669): `checkSystemFieldValues` (`core/src/tx.ts`) displays the `_id` field and the document being written (the
written `_creationTime` in place of the assigned one) with `displayValue`; no call site changed. Tests:
`core/test/system-field-mismatch.test.ts` (insert, patch with a removed field, an int64, replace, `_id` before the
creation time); `differential/test/system-fields.test.ts` (11 writes on both backends, compared with the
`_creationTime` display kept: `errorText` masks it). Sabotage (each restored, `git diff` clean): the fields as JSON (2
unit tests and the differential test fail), the assigned creation time in the display (2 and the differential), the
`_id` as JSON (1 and the differential). Found, not fixed here: `displayValue` shows bytes as `ArrayBuffer(2 bytes)`
where every Convex backend message shows `b"AQI="` (a schema error's `Value:`, `Document(value: …)`, this message):
a change to every message that displays a value, left to its own PR.

### §5 (a query's table and index)

*Built:* #665. The names parse and the index lookup happen at the query's start (`startChecks` in `core/src/tx.ts`, `identifierError` / `indexNameError` in `core/src/query-ops.ts`); `withIndex` still runs the range builder at the call, and its lookup error waits for the start. Tests: `core/test/query-start-errors.test.ts` (every start path, the names, the operators first, the re-run once the table exists), `differential/test/query-start-errors.test.ts` (28 cases, the same answers on both). Sabotage, each caught: no missing-table flag (4 tests), no name parse, `unknown index` back (3), the error at `withIndex` again (2), a third component ignored, `\p{Cf}` dropped from the character display. Found, not changed: `db.system.query("_nope").withIndex(…)` and an unknown index of a private system table throw `Index … not found.` on Convex; bunvex's system reader answers nothing (DV-360's path).

### §6 (a system function's unparsed arguments)

*Built:* `fix/system-function-unparsed-args` (#664). A `_system/` path's arguments that `fromWire` cannot parse (`server/src/server.ts`, the HTTP API and the sync protocol alike) are read again as Convex's system wrapper reads them (`server/src/system-args.ts`, written from the JS library's `jsonToConvex` rules: field names, `$bytes` / `$integer` / `$float` / `$commitTs` / `$set` / `$map`, no nesting limit); what that reader refuses reaches the function as `UnparsedSystemArgs` and `systemArgs` (`functions.ts`) throws it after the access check, as `Uncaught Error: <message>` with no frames. Read past 64 levels, the arguments meet Convex's `op_validate_args`: `Invalid arguments: Value is too nested …` past 64, the plain message at 64 (`[args]` is 65), both seen on the binary. Before / after (Convex = after): ``Invalid arguments for _system/frontend/addDocument.js:default: Field name $x starts with '$', which is reserved.`` → ``Uncaught Error: Field name $x starts with a '$', which is reserved.``; a non-admin still gets "You don't have permission to perform this operation.". Left as they were, noted: arguments too deep to stringify (thousands of levels; Convex's HTTP layer answers "Invalid arguments provided", bunvex keeps "Invalid arguments for …: Value is too nested …"); `$set` / `$map`'s message says "a bunvex type" (rule 5); `$commitTs: null` is read as the placeholder, which a validator's display shows as `CommitTsPlaceholder {…}` where Convex shows `9223372036854775807` (the values package's display, not this path). Tests: `server/test/argument-errors.test.ts` (HTTP and sync, every message, the access order, the nesting boundaries); `differential/test/system-args.test.ts` (16 calls compared with Convex's backend, frames left out). Sabotage (each restored, `git diff` clean): the fallback in `fromWire` off (unit and differential fail), the `UnparsedSystemArgs` check in `systemArgs` off, the reader's error thrown in `fromWire` (before the access check), the 64-level check off, the past-64 check off, the `Malformed` checks off: each failed the unit test.

### §7 (the push's table numbers)

*Built:* #667. `pushOrder` (`core/src/schema.ts`) orders the schema's tables for the catalog: those with any index
(database, staged, search, vector) by name, then the others by name; `allDeclaredTables` (`engine.ts`) puts the system
tables first as before, so the bootstrap's numbers and a component's namespace (`initializeComponentNamespace`, system
tables only) are unchanged. Every path that creates a schema's tables (the CLI's push, `startSchemaPush`, and an engine
started on a schema) goes through it. Checked on the binary: a schema with a database-indexed, a search-only, a
vector-only and a staged-only table among plain ones, mixed case (`Beta`, `Mango` before `aaa`), numbered alike on both;
a second push adding four tables while an existing one gains an index numbers only the new ones, alike (`bee`, `yak`,
`Cat`, `ant`). The order of the `_index` rows a push writes follows the same order now; bunvex's persistence index
ids are its own (not observable), so they were not compared.

- *Tests:* `core/test/catalog.test.ts` (the oracle's two pushes on an engine; the fresh-store and reordering tests
  updated: `posts`, indexed, is now 10001), `core/test/schema-push.test.ts` (`startSchemaPush`'s numbers; `pushOrder`),
  `differential/test/push-table-numbers.test.ts` (both pushes on both backends, `getTableMapping` compared;
  the app `push-order-app/`); `server/test/imports.test.ts` takes the schema's numbers as a push now gives them
  (`posts` 10001, `users` 10002). No test masked the numbers before.
- *Sabotage:* declaration order again (core 4 failed, differential 2); search and vector indexes not counted as
  indexes (core 3, differential 2); names compared with `localeCompare` (case-insensitive; core 3, differential 2);
  the tables without an index left in declaration order (core 4, differential 2). Each restored, `git diff` clean.

## 13. Bytes in a displayed value (found with §4)

**Convex.** Every backend message that displays a value uses `Display for ConvexValue` (`crates/value/src/lib.rs:334-346`),
whose bytes are `Display for ConvexBytes` (`value/src/bytes.rs:46-51`): `b`, then `base64::encode` (the `base64` 0.13
crate's standard alphabet, padded) printed as a Rust string. On the binary: `b"AQI="`, `b""` for an empty buffer,
`b"/+8="`, and 3000 bytes as their whole 4000 characters (no cut). Seen in a schema error's `Value:`, an argument or
returns validator's `Value:`, `Document(value: …)`, a system-field mismatch and a filter's `Cannot use value …`.

**bunvex before.** `displayValue` (`values/src/check.ts`) printed `ArrayBuffer(2 bytes)`.

**bunvex now.** `b"<padded standard base64>"`, whole, for a buffer of any realm. No other display changes.

*Built:* `displayValue`'s bytes branch. Tests: `values/test/error-display.test.ts` (empty, one to three bytes, `+` and
`/`, nested, 3000 bytes, another realm); `differential/test/schema-errors.test.ts` (8 more calls: schema errors and an
argument validator's) and `system-fields.test.ts` (2 more) on both backends. Sabotage (each restored, `git diff`
clean): the old `ArrayBuffer(…)` text, URL-safe unpadded base64, a cut at 100 characters: each fails the unit test and
the differential test. Found, not fixed: a filter's error names the type in Convex's `type_name` (`Bytes`, `Float64`,
`String`, …: `crates/value/src/walk.rs:41-52`) where bunvex's `typeName` (`core/src/filter.ts`) says `bytes`,
`float64`, …

## 14. A filter's type names (found with §13)

**Convex.** A filter's evaluation errors (`crates/common/src/query.rs:744-751` for arithmetic, `:854-857` for `neg`;
`common/src/types/maybe_value.rs:55-63` for a non-boolean predicate) name a value's type with `MaybeValue::type_name`:
`ConvexValueType::type_name` (`crates/value/src/walk.rs:41-52`) for a value (`Null`, `Int64`, `Float64`, `Boolean`,
`String`, `Bytes`, `Array`, `Object`, every type Convex has), `undefined` for a missing one. On the binary:
`Cannot negate b"AQI=" (type Bytes)`, `Cannot use value 1.5 (type Float64) as a Boolean`, `Cannot multiply 1 (type
Int64) and 1.5 (type Float64)`, `Cannot negate undefined (type undefined)`.

**bunvex before.** `typeName` (`core/src/filter.ts`) in lower case: `(type bytes)`, `(type float64)`, `(type null)`.

**bunvex now.** Convex's names. Nothing else in bunvex names a value's type this way (Convex's other `type_name` uses
are its internal serde of system rows, not app messages).

*Built:* `typeName`. Tests: `core/test/filter-type-names.test.ts` (every type, by `neg`, a predicate and two operators;
undefined); `differential/test/filter-errors.test.ts` (18 filters on both backends, app `filter-errors-app/`); the old
names updated in `filter.test.ts` and `server/test/unsupported-value-leak.test.ts` (an opaque value is `(type
Object)`). Sabotage (each restored, `git diff` clean): `float64`, `null`, bytes named `Object`, `Undefined`: each fails
the unit test and the differential test.


## 15. A streamed HTTP action body's chunk that is not bytes (found by STUDY-31 §10.6)

**Convex.** The runtime reads a returned `Response`'s stream into Rust as soon as the handler returns it
(`npm-packages/udf-runtime/src/23_response.ts:270-288` `convexJsonFromResponse`, `06_streams.ts:14-31`
`constructStreamId`): each chunk read goes to the `stream/extend` op (`crates/isolate/src/ops/stream.rs:40-48`), whose
argument is an `Option<ByteBuf>`. serde_v8 (0.311.0) takes null and undefined as `None`, no chunk
(`de.rs:211-220`), and reads anything else as a buffer (`de.rs:448-454`, `magic/v8slice.rs:326-347`): an ArrayBuffer
or any view of one; a shared or resizable one is refused. The op's error rejects the read loop's promise, an
uncaught error in the isolate, which fails the body as STUDY-31 §10 describes: in the handler's turn the run fails
with it (the 500; byte chunks before it are not sent); after the head the response ends cleanly with what was sent,
and the run gets an `error:httpAction` line of it and is logged with the head's status under the request's name. The
message is serde_v8's, raised in Rust, so it has no frames:

- `Uncaught Error: serde_v8 error: invalid type; expected: buffer, got: <type>`, the type named by v8's
  `Value::type_repr` (rusty_v8 `src/value.rs`): `string` (an empty one too), `Number`, `Boolean`, `bigint`, `symbol`,
  `array`, `function`, `Async function`, `Generator function`, `Map`, `Set`, `WeakMap`, `WeakSet`, `Map Iterator`,
  `Set Iterator`, `Date`, `RegExp`, `Promise`, `Proxy`, `SharedArrayBuffer`, a view's own name over a shared buffer
  (`Uint8Array`, `Float64Array`, `DataView`; `TypedArray` for a Float16Array), and `unknown` for any other object (a
  plain object, a Blob, an Error, a boxed string);
- `Uncaught Error: serde_v8 error: can't create slice from resizable ArrayBuffer` for a resizable ArrayBuffer or a
  view of one.

Seen on the binary (`precompiled-2026-10-07-d8bdde0`): every name above, in the handler's turn and after the head;
null and undefined skipped (`first  last`); an ArrayBuffer, a DataView, a Uint16Array and an Int8Array sent as their
bytes.

**bunvex before.** `meteredBody` (`server/src/http-body.ts`) passed every chunk on to Bun's stream: a string was sent
as its UTF-8 text, a number or an object reset the connection after the bytes before it, and a null or undefined
chunk ended the body with an `error:httpAction` line of Bun's `TypeError` (`null is not an object (evaluating
'value.byteLength')`). A chunk that is not bytes never failed the run.

**bunvex now.** As Convex. `meteredBody`'s pull skips null and undefined, and fails the body with Convex's error
(the same type names, an `Error` with no frames; its words are bunvex's, DV-529 below) for any other chunk that is not an unshared, fixed-length ArrayBuffer or
a view of one: after the head, the clean end and the line of STUDY-31 §10. For the handler's turn, Convex reads the
body at once, so `failedEarly` now reads what the body has ready during its 32 microtask turns (the reads are kept
in order and sent by the pull): a chunk that is not bytes found there fails the run with the 500. The turn is
DV-485's (accepted): a start that enqueues its chunks at once is caught whatever their number, and a pull that
enqueues it after more microtask-only awaits than the turn holds (~10 per pull over two pulls) ends cleanly with the
line where Convex answers the 500.

*Built:* `http-body.ts` (`isBytes`, `notBytes`, `typeRepr`, the reads of `failedEarly`); `functions.ts` unchanged.
The cost of the turn's read, in process (50 000 one-chunk streams, three rounds): 1.89–1.92 µs a body before,
1.94–2.42 µs after, within the noise of a request (~50 µs at 20k req/s); no HTTP benchmark was run (the Mac was
shared). Tests: `server/test/http-body-chunks.test.ts` (every name, a resizable buffer, bytes of each kind with null
and undefined, a late chunk's line), `server/test/http-action-response-log.test.ts` (the 500 with no frames and its
Completion; a late number's clean end and line; null, undefined and buffers through a real server); and
`differential/test/http-body-error.test.ts` (23 more streams, `/chunk/` of `http-body-errors-app/`, on both
backends: status, body, clean end, the 500's `code` and `trace` line, every log entry). Sabotage (each restored,
`git diff` clean): no check in the pull (unit and oracle fail); no reads in the turn (unit and oracle fail); null not
skipped (unit and oracle fail); a resizable buffer accepted (unit and oracle fail); a shared one accepted (unit and
oracle fail); `number` for `Number` (unit and oracle fail); the error's frames kept (unit fails; the oracle compares
first lines only).

**The words (DV-529).** serde_v8 is the library Convex's isolate converts values with; bunvex has no such library,
so its message would name something bunvex does not use. The owner chose bunvex's own words (2026-10-15, option
(b); option (a) was Convex's text), with everything else as Convex: when the body fails, the status, the body, the
clean end, `Uncaught Error: `, no frames, the line and the Completion. The type names stay v8's (`string`, `Number`,
`unknown`, …): they are the ones Convex reports, checked one by one on its binary, so a chunk Convex names one way
bunvex names the same way. The messages:

- `HTTP action response body chunks must be an ArrayBuffer or a view of one, got <type>`;
- `HTTP action response body chunks must not be a resizable ArrayBuffer or a view of one`.

*Built (DV-529):* `notBytes`'s two messages. The differential test reads each bunvex message back into serde_v8's
words (and fails if one is left over, or if bunvex still says serde_v8) and compares everything else as before.
Sabotage (each restored, `git diff` clean): serde_v8's words back (unit and oracle fail); `number` for `Number`
(unit and oracle fail); other words for the resizable buffer (unit and oracle fail); frames kept (unit fails).

Found, not fixed: the 500's `trace` for an error with no frames ends with a newline on Convex
(`"Uncaught Error: serde_v8 …\n"`, `"Uncaught a string\n"`) and without one on bunvex (`http-actions.ts`
`errorResponse` strips it), for every such error, not only these.

## 16. Counting reads toward the read limit (found by STUDY-149 "Bulk edit")

Owner, 2026-10-15: option (a), match Convex's count, in two steps (this study, then one PR, a draft until its
read-path measurement). **Only the count changes**: the intervals bunvex records for subscriptions and OCC stay exactly
as they are.

### 16.1 The symptom

`_system/frontend/patchDocumentsFields` without `ids` on a table of exactly 4 094 documents: Convex fails on the last
patch, inside the function's rewrap (`Uncaught ConvexError: Too many reads …`, with data); bunvex's patches pass and
the audit event's insert goes over (`Uncaught Error: Too many reads …`, no data). Both count N + 3 in all, in another
order. The cause is general: bunvex counts reads differently from Convex.

### 16.2 How Convex counts

`TransactionReadSet` (`crates/database/src/reads.rs`) keeps, per index, an `IntervalSet` of everything the transaction
read, merged: `IntervalSet::add` (`common/src/interval/interval_set.rs:150-215`) folds an interval into every
overlapping **or adjacent** one; an empty interval adds nothing; `Interval::all` makes the set `All`. The limit's count,
`num_intervals`, moves only on `record_indexed_directly` (`reads.rs:447-492`): it adds the change of that index's set size
(`after − before`, the subtraction saturating), then fails past `database_queries` (4 096) with "Too many reads in a single
function execution (limit: 4096). …". `record_indexed_derived` (`:337-344`) adds to the set **without counting**: reads
the engine takes on its own behalf. A derived interval still occupies the set, so a later direct read it covers adds
nothing.

- **Direct** (counted): a document by id (`transaction.rs:1150-1175`, a singleton on `by_id`); each page of an index
  range or scan (`query/index_range.rs:222-256`, the range the page covered, so a query's consecutive pages merge);
  system queries (`system_query.rs:276`); a table's count (`table.rs:134`, all of its `by_id`); `take_indexes_dependency`
  (`bootstrap_model/index.rs:924`); the preloaded environment variables (`preloaded.rs:51`).
- **Derived** (not counted): the table mapping (`transaction.rs:885`, all of `_tables`); index metadata
  (`transaction_index.rs:652`); a write's table and indexes (`writes.rs:377-436`: its `_tables` row, the `_index`
  virtual index); **a new document's id** (`writes.rs:436`, `register_new_id`: a prefix on the table's `by_id`); the schema
  (`schema_registry.rs:229`); components (`component_registry.rs`).
- A text search records its terms with `record_search`, outside the intervals (not counted); its hits are fetched by id
  (direct, one point each).
- A nested `runQuery` / `runMutation` reads into the same transaction's set (`merge`).

### 16.3 What an app observes (the oracle, `precompiled-2026-10-07-d8bdde0`)

Measured by the warning's `actual` (`Many reads … (actual: N, limit: 4096)`), 3 300 distinct `db.get`s plus one shape:

| shape | Convex | bunvex today |
|---|---|---|
| the gets alone (a query or a mutation) | +3 | +3 |
| get a document again; patch, replace a document read | +0 | +1 |
| insert (into a known table, twice, then get or patch it) | +0 | +1 |
| insert into a new table (one or two new tables) | +1 | +8 / +12 |
| first / collect / take / desc / filter of a table | +1 | +2 (`take` of the read table +1) |
| the same scan twice | +1 | +3 |
| `withIndex` eq; twice the same; two values | +1; +1; +2 | +3; +5; +5 |
| ranges `[10,20)` then `[20,30)` (adjacent) or `[15,30)` (overlapping); with a gap | +1; +2 | +4 |
| `count` of the read table (all of its `by_id` swallows the 3 300 points) | ≈ +1 in all (no warning) | +1 |
| a missing table; two | +0 | +1; +2 |
| `db.system` query | +1 | +2 |
| a search: no hit; 10 hits; twice | +0; +10; +10 | +2; +12; +23 |
| `scheduler.runAfter` | +0 | +2 |
| a first nested `runQuery` / `runMutation` (empty); a second | +2; +0 | +0; +0 |
| a nested query re-getting 100 of the caller's documents | +2 | +100 |
| `patchDocumentsFields`, N documents (a system function) | N + 3 | N + 3 |

**The constants.** A user function's transaction starts with three direct reads, made before its code runs
(`isolate/src/environment/udf/phase.rs` `initialize` and `get_module`): `_udf_config` (`UdfConfigModel::get`), the
environment variables (`PreloadedEnvVars::load`) and its module (`ModuleModel::get_metadata`, `_modules` by path). A
system function has no module row: two. bunvex's own three happen to be others: the `_canonical_urls` scan and its
`_tables` row (read for the default system variables) and the used table's `_tables` row.

### 16.4 bunvex today

`Tx.recordInterval` (`core/src/tx.ts`) pushes every interval onto `readList` and counts its length (less the
`_backend_state` read, `uncountedRead`). So it counts the table and index metadata it reads for invalidation (`dependOn`,
`recordIndexMeta`, `readMissingTable`), the search's term intervals, its own catalog reads when it creates a table, and
every repeat; and nothing merges.

### 16.5 The plan (one PR)

1. **`ReadCount`** (`core/src/read-count.ts`): Convex's per-index merged interval sets and `num_intervals`, `direct` and
   `derived`, with Convex's saturating update. `Tx` keeps one beside `readList`; `readList` is untouched, so what a
   subscription or a commit's conflict check sees does not change.
2. **Which bunvex reads are direct**: a document by id, a page of a query or scan, a `db.system` read, a count. **Derived**:
   `dependOn`, `recordIndexMeta`, `readMissingTable`, the `_backend_state` read, the environment and canonical URL reads,
   a search's term intervals, the reads of a table's creation, and, recorded in the count only, a new document's id
   (Convex's `register_new_id`).
3. **The constants**: a function's transaction counts Convex's three (two for a `_system/` function) when it starts, as
   intervals of their own (they never merge with what a function can read); a table created by the transaction counts
   one, once; the first nested call counts two, once.
4. The limit, the "Many reads" warning, the read-limit split of `paginate` (`readsFull`) and a nested call's budget read
   the new count. Documents and bytes read (their own counters, `record_read_document`) are checked by the sweep too.
5. **Tests**: `ReadCount` unit tests (merging, adjacency, saturation, derived coverage); the existing reactivity, OCC and
   subscription tests unchanged, plus new ones asserting `readList` is the same as before for each shape above; a
   differential sweep of every shape in §16.3 (and the 4 094 bulk edit, get-then-patch, re-reads, several tables, adjacent
   pages, missing tables, nested calls, queries and mutations) comparing `actual` on both backends.
6. **Measurement**: the read path gains a sorted-set insert per read; the PR stays a draft until the owner's
   before/after run (`bench/`), prepared in the PR.

*Built* (draft, waiting on its measurement):
- `core/src/read-count.ts`, Convex's per-index merged sets and `num_intervals` (its saturating update included). `Tx`
  keeps one beside `readList`: `recordInterval(i, "direct" | "derived" | "none")`. Derived: `dependOn`, `readMissingTable`,
  `recordIndexMeta`, the environment variables' per-name reads, a search's terms, and (in the count only) a new
  document's id. Not counted: `unrecorded`, the new `notCounted` (the canonical URLs of the default system variables;
  a table's creation, which counts one, once). A scan counts at its first document and widens as it settles (a counted
  read on the same index settles it first); `count` counts all of the table's `by_id`.
- **The modules.** Convex reads a `_modules` row for each module a function loads: its own and every chunk it imports.
  esbuild puts Convex's library into a chunk of its own once two or more function modules use it; bunvex links its
  library, so `CodeVersion` counts that chunk where Convex's would be (unless one of the app's own chunks has the same
  importers), each module once per transaction (a nested call to another module counts its new ones).
- Function starts count 2 plus the modules (a `_system/` function, 2); the first nested call 2.
- Tests: `core/test/read-count.test.ts` (`ReadCount`: merging, adjacency on either side, bridging, empty intervals,
  derived intervals, saturation; a transaction's count per shape; the limit at the read that passes it);
  `core/test/read-set-unchanged.test.ts` (17 shapes' read-sets equal to those main recorded before the change,
  `fixtures/read-sets.json`); `differential/test/read-count.test.ts` (app `read-count-app/`, both backends at a limit
  of 60: 52 shapes' counts, 6 shapes at 4 bases around the limit, a nested call's budget, the bulk edit at 54–58
  documents: the error inside the rewrap with its data on both). Updated to the new count: `tx-b-edges`,
  `paginate-limits` (a page from an `end` cursor reads an empty interval: done, no split), `read-limits`,
  `limit-warnings`, `nested-calls`, `pause-deployment` (the caller's usage includes the start's reads).
- Sabotage (each restored, `git diff` clean): no merging (7 unit and 2 differential tests fail); adjacency on one side
  only (1 unit); derived reads counted (3 unit, 4 differential); no start reads (3 differential); no library chunk (3
  differential); no nested reads (3 differential); a new id not in the set (1 differential); the count on the default
  index (1 unit, 1 differential).
- Bytes and documents read keep their own counters (Convex's `record_read_document`), unchanged.
- **The first measurement** (2026-10-15, interleaved, 4 runs each) showed regressions: 4 000 distinct gets +29 %,
  1 000 index ranges +97 % (every counted read looped over all the transaction's unsettled scans), 100 gets +12 %,
  a scan with a get per document +13 %, one document 4 000 times +7 %. A second, after grouping the unsettled scans by
  index and ordering the sets in O(log n) (sorted chunks beat a B-tree on every shape), still showed +7 % to +19 %.
  A third, with points as a hash set and the last interval kept (owner, option (b)): 100 gets +11 %, 4 000 gets +9 %,
  one document 4 000 times +12 %, a scan with a get per document +9 %, 1 000 index ranges +22 % — a cost on every
  counted read, near the limit or not.

- **Q2 (DV-521), accepted (owner, 2026-10-15):** the module count is esbuild's chunking as bunvex can predict it.

**Q2 (DV-521) — the modules a function loads.** Accepted (owner, 2026-10-15).

- *Convex:* one read per module the function loads; how many depends on how esbuild chunked the push (its library in a
  chunk once two function modules use it; the app's shared code in chunks per set of importers).
- *bunvex:* the same count from its own bundle (Bun.build's chunks of the app's code) plus Convex's library chunk where
  esbuild would make one; matched on every app the sweep tried (one module; two or more modules).
- *Same?* Yes on the apps tried; possibly not where esbuild and Bun.build chunk the app's own shared code differently.
- *Why:* "Não dá pra fazer" exactly without esbuild's chunking (as DV-520).
- *App impact:* a function within one or two reads of the 4 096 limit, in an app whose shared code chunks differently,
  could pass on one backend and fail on the other.
- *Recommendation:* accept (a): the prediction as built.
- *Decision:* accepted, the prediction as built (owner, 2026-10-15); DV-521 in [divergences.md](../parity/divergences.md).

### 16.6 Counting exactly only when it can matter (owner, option (c))

The shortcuts are gone; sorted chunks are the only exact set (`ReadCount`). `ReadCounter`, which `Tx` keeps, has two
modes:

- **A bound and a log** (from the start): `bound` is one per interval added (direct or derived) plus the constants, and
  the log keeps each addition in order (a scan's first read as a reference to its first document, resolved later).
- **The bound is never below the exact count.** A direct addition moves the exact count to `max(0, count − before) +
  after`: with `count ≥ before` that is at most one more, since an addition grows its set by at most one; with `count
  < before` it is `after`, the set's size, which is at most the intervals ever added to it, so at most the bound. A
  derived addition does not move it, and a constant moves both alike.
- **Each consumer compares the bound to its own point**, so there is no fixed threshold: the limit check (on every
  counted read: past the limit by the bound, then exactly) and `paginate`'s full-reads check; the warning (`Many
  reads`, past its floor `⌊ratio × 4 096⌋`: under it by the bound there is no warning and no number); a nested call's
  budget and `ctx.meta` (`usage.databaseQueries`, exact when read). The first exact answer replays the log in order into
  `ReadCount`, so Convex's order-dependent, saturating arithmetic comes out the same; the count is exact from then on.
- **A scan** counts its first read at its first document without working out the key: the interval is resolved from
  the document (its key, or its key values taken when it was handed out, or the document itself, which the app never
  held) only if the exact count is ever needed. What it grows by later is counted when it settles, as before.

*Tests:* `core/test/read-count.property.test.ts`: random direct, derived and scan reads and constants over three
indexes against the plain sorted array, read after read: `ReadCount` exact; the bound never below the reference; the
exact count right from any first ask on; a limit's answer and a warning's number right, with limits of 0 to 12 so the
bound crosses them at random points. Sabotage (each restored): the bound short of derived reads, short by one on
constants, a replay without the derived reads, a reordered replay, the warning's number taken past its floor + 1, no
replay at all, a scan's first read resolved at once: each fails it; the warning taking the bound alone fails
`limit-warnings`. The read-set-unchanged, unit and differential tests (the at-limit and nested-budget shapes included)
pass unchanged.
