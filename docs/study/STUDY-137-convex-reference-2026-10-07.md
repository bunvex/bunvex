# STUDY-137 — Convex from 4577b90 to precompiled-2026-10-07-d8bdde0

- **Status:** implemented, except the items in §4 that wait on the owner (DV-435–DV-439).
- **Convex source read:** get-convex/convex-backend from `4577b9031` (2026-09-28, the parity reference until
  now) to the release tag `precompiled-2026-10-07-d8bdde0`. That is 138 commits, of which 72 touch the
  runtime, the CLI or the npm package; each of the 72 was read and checked against bunvex.
- **bunvex code read:** `main` at `fe82069` (after #510).
- **Related:**
  - [STUDY-122](STUDY-122-differential-testing.md): the differential oracle moves to this release; #504 was
    an oracle bug (3071059) fixed in it.
  - [STUDY-78](STUDY-78-write-throughput-limit.md) (rows limit), [STUDY-31](STUDY-31-http-actions.md) (100 MiB),
    [STUDY-67](STUDY-67-http-function-api.md) (module paths), [STUDY-59](STUDY-59-log-streams.md) (S3 export),
    [STUDY-118](STUDY-118-usage-limits-cli.md) (CLI metric), [STUDY-133](STUDY-133-persistence-layout-identical.md)
    (`max_repeatable_ts`), [STUDY-106](STUDY-106-staged-validator.md) and
    [STUDY-127](STUDY-127-schema-validation-tables.md) (staged validators).

## 1. How Convex changed

The range holds no new feature an app calls. It holds message changes, two new limits, a raised limit, and a
few bug fixes. The commits with app-visible effects:

- **b352fab — Stop leaking internal error text into function logs.**
  - A nested call that fails no longer stacks `Uncaught Error: ` once per level. `format_uncaught_error`
    (`crates/isolate/src/helpers.rs`) keeps a message that already starts with `Uncaught <Name>: `.
  - `TooManyConcurrentRequests` names the kind in the plural: queries, mutations, actions, HTTP actions. It
    used to append "s" to the kind.
  - `SystemIdentityRequired` reads "You don't have permission to perform this operation." It used to read
    "Operation <op> not permitted".
  - Skipped cron runs: "Skipping N run(s) of cron job '<name>' because multiple scheduled runs are in the past".
    The job is named, not its id.
  - An OCC conflict caused by a system writer no longer prints its internal name. `convex_writer_description`
    (`crates/database/src/transaction.rs`) gives:
    - "An edit in the Convex dashboard" for `_system/frontend/*`;
    - "A Fivetran sync" or "An Airbyte sync";
    - "A data import" for `snapshot_import*`;
    - "A Convex system operation" otherwise.
  - Typos fixed: "must be validators" (`v.record()`); "so must specify an ApplicationID" (auth config).
- **75d250e — Write throughput by rows.**
  - Each commit records its rows (`document_writes.len() + index_writes.len()`) next to its bytes
    (`WriteVolume`, `crates/database/src/write_throughput_limiter.rs`).
  - The knob is `MAX_ROWS_WRITTEN_PER_SECOND`. The default 0 means no rows limit.
  - `exceeded_limit` checks the bytes first, then the rows.
  - The bytes message now says "per second" whatever `WRITE_THROUGHPUT_WINDOW` is.
  - The rows message: "Too many writes per second. Your deployment is limited to N document and index rows
    written per second. Reduce your write rate, remove unused indexes, or upgrade to a larger deployment."
- **82e5c50 — HTTP action responses up to 100 MiB.**
  - `HTTP_ACTION_RESPONSE_BODY_LIMIT` is `100 << 20`; it was 20 MiB.
  - Once one chunk would cross the limit (`http_response_too_large`), every later chunk is dropped too.
    Before, a later chunk that fit was still sent.
  - The size warning is not logged once the error was.
  - The router's `DefaultBodyLimit` is gone; multipart bodies stay at 20 MiB.
- **8ecf38b — `InvalidModulePathError`.**
  - Every module path reason starts with `Invalid module path '<p>': `, and the path left the reason's own
    words: "Module path doesn't have a filename.", "Module path has an extension that isn't 'js'.", "Module
    paths must be relative.", "Invalid path component CurDir.".
  - A too-long component's prefix is whole characters within 64 UTF-8 bytes.
  - `parse_module_path`'s 400 (`BadConvexModuleIdentifier`) is that error alone.
  - `parse_udf_path` still prefixes "<path> is not a valid path to a Convex function." (`crates/local_backend/src/parse.rs`).
- **aab5a04 — `stringifyValueForError`** (`npm-packages/convex/src/values/value.ts`).
  - A function prints as `"[Function]"` and a symbol as its description, wherever they are. Before,
    `JSON.stringify` dropped them from objects, made them null in arrays, and gave `undefined` at the top.
  - Result: `Function "[Function]" is not a supported Convex type (present at path .cb …)`.
- **4933aa2 — S3 export needs ViewData.** `create_log_stream` for an `s3Export` and `update_log_stream` on one
  also require `ViewData` (`crates/local_backend/src/log_sinks.rs`).
- **b11a570 — CLI.** `aiGatewayCostDollars` ("AI Gateway") joins the usage-limit metrics
  (`npm-packages/convex/src/cli/lib/usageLimits.ts`).
- **c04e2f7 — `max_repeatable_ts` re-arm race.**
  - Case: a commit published while a bump was being written.
  - Before, it got the idle bump, 1–2 h later.
  - Now it gets another bump after `MAX_REPEATABLE_TIMESTAMP_COMMIT_DELAY` (`needs_follow_up_bump`,
    `crates/database/src/committer.rs`).
- **aad76a4 — Count deltas restored on subtransaction rollback.** A parent's `db.count` no longer counts a
  caught nested mutation's writes.
- **3071059 — Paging over pending writes.**
  - Convex merged pending writes past the snapshot page's cursor into the page, which duplicated or skipped
    documents.
  - This is the bug the differential nightly found (#504). bunvex never had it.
- **644e25f — RegExp legacy statics removed** from the isolate (`RegExp.$1`, `lastMatch`, `input`, …).
- **fb75332 — `ctx.storage.store()` in mutations, part 3 of a series.**
  - The syscall writes the `_file_storage` row and stages the bytes.
  - New errors: `TooManyFilesWritten` and `FilesWrittenTooLarge`.
  - At this tag nothing uploads the staged bytes yet (its own comment): the id it returns has no file.
- **2ada334 — Staged validator rows.**
  - A schema with `.staged()` validators gets one `_schema_validations` row per staged table:
    `{schemaId, tableName, validatorHash, state}`.
  - State carries over from the active or overwritten schema when the hash matches.
  - Failed rows go back to pending when the same schema is pushed again.
  - Activation deletes only the enforced rows.
  - A push that stages validators on tables whose enforced validator change needs a walk is refused: 400
    `StagedSchemaWithEnforcedValidatorChanges`.
  - The background walk of staged validators is not in this tag.
- **4991db1 — System function arguments that do not parse are user errors.** One example: an array over 8192
  elements gives `InvalidArguments` "Invalid arguments: Array length is too long (8193 > maximum length
  8192)". User functions already failed with "Invalid arguments for <path>: …" (`crates/udf/src/validation.rs`).

## 2. What an app can observe

- Error and log text, listed above.
- A deployment with `MAX_ROWS_WRITTEN_PER_SECOND` set refuses writers with the rows message.
- An HTTP action can answer up to 100 MiB, and a body past it is cut at the first chunk that crosses.
- An admin whose key lacks ViewData cannot create or change an S3 export. In bunvex every key with
  WriteIntegrations also has ViewData, so only scoped keys would see this.
- Inside functions: the RegExp statics, and `ctx.storage.store()` in a mutation (§4).

## 3. What bunvex changes

Each item below has a test, and the test was run against the item's code removed, where that makes sense
(sabotage check):

| Convex | bunvex | Test |
|---|---|---|
| b352fab prefix | `describeUncaught` keeps a message already `Uncaught <Name>: …` (`server/src/errors.ts`) | `action-nested-errors.test.ts` |
| b352fab plurals | `PLURAL` in `server/src/action-permits.ts` | `function-limits.test.ts` |
| b352fab messages | `SystemIdentityRequiredError`, the cron skip line, the two typos | `system-identity`, `admin-access`, `undefined-validators` tests |
| 75d250e | `WriteThroughputLimiter` records rows (`committer.ts`: docs + index writes); `MAX_ROWS_WRITTEN_PER_SECOND`; `exceeded()` bytes then rows; both messages "per second". bunvex keeps its "set … to raise the limit" sentence in place of the upgrade offer, as STUDY-78 decided. `formatWindow` is gone (unused) | `server/test/write-throughput.test.ts` |
| 82e5c50 | `HTTP_ACTION_RESPONSE_LIMIT = 100 << 20`; `tooLarge` drops every later chunk and suppresses the size warning (`http-body.ts`, `limit-warnings.ts`) | `http-action-response-log.test.ts` |
| 8ecf38b | `checkModulePath` prefixes `Invalid module path '<p>': `; `utf8Prefix` for the too-long prefix; `badModulePath` is the error alone (`function-path.ts`) | `function-path`, `get-query`, `run-test-function` tests |
| aab5a04 | `stringifyValueForError` prints `"[Function]"` and a symbol's description (`values/src/value.ts`) | `values/test/error-display.test.ts` (the reference is Convex's new replacer) |
| 4933aa2 | `create_log_stream` / `update_log_stream` require ViewData for an S3 export | `log-sinks.test.ts` |
| b11a570 | `aiGatewayCostDollars` in `USAGE_LIMIT_METRICS`, label "AI Gateway" | `cli/test/deployment.test.ts` |
| c04e2f7 | `followUp` on the committer's repeatable bumps | `core/test/repeatable-ts.test.ts` |
| aad76a4 | bunvex already right: `Tx.countTable` adds the transaction's own writes, and a rollback restores them. A regression test pins it | `server/test/count.test.ts` |
| 4fd5950 | comment only (`MYSQL_SMART_CHUNK_MAX_SIZE`) | — |

Measurement: the rows limit adds one number per commit to the limiter's window, plus an addition on the
check. The limiter keeps no other state, and the hot path (`record`, the under-limit check) stays O(1).

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| R1 (DV-435) | OCC conflicts caused by a system writer still read `A call to "<label>"`. Convex now prints a description of the writer, and four of its five descriptions contain "Convex" | The repository's rule bans "convex" in shipped strings. Recommendation: match the structure with bunvex's words: "An edit in the dashboard", "A Fivetran sync", "An Airbyte sync", "A data import", "A system operation" | pending (owner) |
| R2 (DV-436) | `RegExp.$1`, `lastMatch`, `input` and the other legacy statics still work in functions. Convex removed them (644e25f) | Bun's JSC has them. Deleting them from each version's `vm` context is cheap. Recommendation: match Convex in the isolate context. It is not checked whether Convex's Node executor removes them too | pending (owner) |
| R3 (DV-437) | `ctx.storage.store()` in a mutation still throws "not supported in queries and mutations yet". Convex's syscall now writes the row (fb75332), but nothing uploads the bytes yet | The series is half-built at this tag. Recommendation: keep the current behaviour until the upload lands upstream, then match | pending (owner) |
| R4 (DV-438) | No `_schema_validations` rows for staged validators, and no 400 `StagedSchemaWithEnforcedValidatorChanges` (2ada334) | Needs a study update (STUDY-106/127): the background walk it prepares for is not in this tag. Recommendation: match the push refusal and the rows in a follow-up | pending (owner) |
| R5 (DV-439) | Function arguments are not checked against the value limits (array length 8192, field count) before the call; Convex fails with `InvalidArguments` (4991db1 made the system functions' case a user error too) | A gap older than this range, not verified end to end. Recommendation: match in a follow-up | pending (owner) |

Not divergences:

- **Web API commits** (URL, URLSearchParams, Request/Response, FormData, DOMException, TextDecoder, crypto,
  atob/btoa, Intl): functions use Bun's globals (DV-164, DV-02). The ones probed already behave as Convex's
  new code: `new atob()` throws, `Intl.v8BreakIterator` is undefined, and `formatToParts` is not
  constructible.
- **f1c868e** (`CommitterFullError` text): bunvex has no committer queue limit. If one is added, the new text
  is "Too many writes in a short period of time. Reduce your writes, spread your writes out over time or
  remove unused indexes to reduce load and avoid errors."
- **Text search** (9688fe5, 309e941, 5c7cb5b, 54fbd82, 4f4327f, afd409c, bc961f4): bunvex already matches an
  exact term plus an ordered prefix scan on the field's own terms, with a 0.5 prefix boost.
- **Cloud-only, internal or components:** b7ae984, 58752ea, 0068f12, b05af0d, a3538c6, 7e2fc16, 706b8a0,
  0ce6883, f121e4e, 6c8ae5a, 0f9aa19, 1bce26d, 9c14e36, b274fdb, da73af1, ff451b2, 729aa1c, 4f87cc3, 596eebd,
  d2ca853, 73d8bc6, 632c9d6, 180b900, ea273f5, 248fb57, 9ea29e8, a69c218, b4ff21c, 426fac9, 61deb7d,
  aa4108d.
- **588c89b** (MCP mutex): `cli/src/mcp.ts` already chains its calls.
- **2aacfe1** (cancel a backfill for a dropped index): bunvex's worker drops a dropped index's checkpoint
  (`engine.ts`). Whether a backfill already running stops is an open question (§6).

## 5. Tests

- Each change in §3 has its test, and each test fails with the change removed, except the aad76a4
  regression test: bunvex's count was already right.
- **Differential (STUDY-122) against `precompiled-2026-10-07-d8bdde0`:** the 18 fixed programs and 1500
  generated ones (`DIFF_RUNS=1500`) agree with zero differences. Program #504, which disagreed with the
  previous oracle, agrees.

## 6. Open questions

- Whether bunvex stops a backfill already running when its index is dropped (2aacfe1).
- Whether an HTTP action refused by the concurrency limit should say "HTTP actions". Convex's limiter has a
  separate `HttpAction` kind for that word; bunvex's HTTP actions share the action limiter (STUDY-68) and say
  "actions".
- Whether Convex's Node executor also removes the RegExp statics (R2).
