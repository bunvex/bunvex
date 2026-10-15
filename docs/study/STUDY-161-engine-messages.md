# STUDY-161 — Engine messages found with the dashboard

- **Status:** decided (owner, 2026-10-15: match Convex on the differences STUDY-149 PR 3 found); one PR per
  concern (§1–§7, each section's *Built* line); §8 open (Q1, DV-520)
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

## 8. The line the push analysis records for a function (open: Q1)

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

*Built:* nothing (Q1 open).

## 9. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| Q1 (DV-520) | The line a function is listed at in the dashboard's Functions tree (`modules:listForAllComponents`'s `lineno`, the order of a file's functions) can differ from Convex's for the same source | Convex's number comes from esbuild's printed bundle under an off-by-one lookup; bunvex bundles with Bun.build | **open (owner)** |

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

## 10. Tests

Each section's PR: unit tests next to the code it changes (`core/test`, `server/test`), the differential test's mask
for the item removed (`differential/test/dashboard-writes.test.ts`, `dashboard-functions.test.ts`), and a
differential test of the messages on both backends where the oracle can show them. Each PR breaks its fix a few ways
and lists what failed in its *Built* line.

## 11. Open questions

- Q1 (§8, DV-520).

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

*Built:* not yet.

### §5 (a query's table and index)

*Built:* #665. The names parse and the index lookup happen at the query's start (`startChecks` in `core/src/tx.ts`, `identifierError` / `indexNameError` in `core/src/query-ops.ts`); `withIndex` still runs the range builder at the call, and its lookup error waits for the start. Tests: `core/test/query-start-errors.test.ts` (every start path, the names, the operators first, the re-run once the table exists), `differential/test/query-start-errors.test.ts` (28 cases, the same answers on both). Sabotage, each caught: no missing-table flag (4 tests), no name parse, `unknown index` back (3), the error at `withIndex` again (2), a third component ignored, `\p{Cf}` dropped from the character display. Found, not changed: `db.system.query("_nope").withIndex(…)` and an unknown index of a private system table throw `Index … not found.` on Convex; bunvex's system reader answers nothing (DV-360's path).

### §6 (a system function's unparsed arguments)

*Built:* not yet.

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
