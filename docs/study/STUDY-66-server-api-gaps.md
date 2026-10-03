# STUDY-66 — Small server-API gaps: `.limit(n)`, the operator cap, `db.table()`, returned queries, the restricted globals, bad tokens, schema helpers, registration guards

- **Status:** draft; each section is built in its own PR ("Now" describes the PR's change)
- **Convex source read:** commit `4577b9031` of get-convex/convex-backend
- **Related:** [STUDY-03](STUDY-03-deterministic-execution.md) (deterministic execution),
  [STUDY-07](STUDY-07-query-semantics.md) and [STUDY-16](STUDY-16-query-chaining.md) (queries),
  [STUDY-14](STUDY-14-schemas.md) (schemas), [STUDY-15](STUDY-15-query-filter.md) (D1: the operator cap),
  [STUDY-31](STUDY-31-http-actions.md) (bad tokens in HTTP actions), [STUDY-36](STUDY-36-codegen.md) (types)

This study covers the rows of [server-api.md](../parity/server-api.md) and [platform.md](../parity/platform.md)
that were *missing* or *partial* and small. Each item has its own section and ships in its own PR.
Components and Convex-cloud features are out of scope.

## 1. `.limit(n)` and the query-operator cap

### 1.1 How Convex does it

- `npm-packages/convex/src/server/impl/query_impl.ts`:
  - A query is serialized as `{ source, operators }`. An operator is `{ filter: <expression> }` or
    `{ limit: n }`, in the order the app chained them.
  - `limit(n)` (L243-248) checks only that `n` was given (`validateArg`: TypeError "Must provide arg 1 `n`
    to `limit`"), then pushes `{ limit: n }`. It closes the query it was called on, as every operator does.
    `QueryInitializerImpl.limit` is `fullTableScan().limit(n)` (L120-122).
  - `limit` is `@internal` in `server/query.ts` (L202-210). The published types are built with
    `stripInternal` (`tsconfig.json`), so a TypeScript app does not see it; it exists at run time.
  - `take(n)` validates `n` (non-negative integer), then is `this.limit(n).collect()` (L322-327).
    `first()` is `take(1)`, `unique()` is `take(2)`.
  - `MAX_QUERY_OPERATORS = 256` (L22). Only `filter` checks it, before it pushes (L228-236):
    with 256 operators already, it throws `Can't construct query with more than 256 operators`. `limit`
    does not check.
- `crates/common/src/json/query.rs` L313-323: the backend parses the query when it starts
  (`queryStream` for `collect` / `take` / `first` / `unique` / `for await`, `queryPage` for `paginate`):
  - `serde_json::from_value` first: `limit` is a `usize`, so a negative, fractional, too large or
    non-number `n` fails here, with serde's text (e.g. `invalid value: integer `-1`, expected usize`,
    `invalid type: floating point `1.5`, expected usize`, `invalid type: string "5", expected usize`).
  - then `operators.len() <= MAX_QUERY_OPERATORS`, else `Query has too many operators: N`.
  - `crates/isolate/src/environment/helpers/mod.rs` L39-57 (`with_argument_error`) wraps both as a user
    error: ``Invalid argument `query` for `queryStream`: <cause>`` (or `queryPage`).
  - So the cap can be passed on the client and refused at the start: 256 filters then `.take(1)` (the 257th
    operator is take's limit), or 255 filters and two limits.
- `crates/database/src/query/mod.rs` L450-462: each operator wraps the node before it, so the pipeline runs
  in chain order. `crates/database/src/query/limit.rs`:
  - `next` returns "done" once `limit` rows have come out, **without pulling from its inner node**;
  - its prefetch hint is at most the rows still allowed;
  - its cursor is the inner node's.
- In order: `.limit(5).filter(f)` keeps those of the first 5 that pass; `.filter(f).limit(5)` keeps the
  first 5 that pass. Any limit that is full ends the whole stream: the next pull from outside reaches it
  first.
- In `paginate` (`crates/isolate/src/environment/udf/async_syscall.rs` L1812-1866, `read_page_from_query`):
  - a full limit ends the page like the end of the range: `query.cursor()` is the index range's position
    (after the last document read), so `isDone` is false and `continueCursor` points past it. The next
    page reads up to `n` more.
  - `limit(0)` in `paginate` reads nothing, so the cursor is never set: "Cursor was None", a **system**
    error (no `ErrorMetadata`).

### 1.2 What an app observes

- `.limit(n)` at any point of the chain, any number of times, before or after `filter`, on an index range,
  a full scan or a search. Results are the pipeline's, in chain order.
- `.limit()` with no argument: TypeError at the call. A bad `n` (negative, fractional, ≥ 2^64, not a
  number): an error when the query starts, ``Invalid argument `query` for `queryStream`: …``.
- The 257th `filter`: ``Can't construct query with more than 256 operators`` at the call. More than 256
  operators at the start (limits and the terminal's limit included): ``Invalid argument `query` for
  `queryStream`: Query has too many operators: N``.
- What a limited query reads: up to the document that fills the limit, so its read set (and what
  invalidates a subscription) stops there.

### 1.3 How bunvex does it

- Before: `QState.filters` (a list of filter expressions, applied together), and the terminal's limit as an
  argument of `runQuery`. No `limit`, no cap.
- Now (`packages/core/src/tx.ts`): `QState.ops`, the operators in chain order (`{filter}` or `{limit}`).
  - The terminal operations add their limit as Convex's do: `take(n)`, `first()`, `unique()`.
  - One pipeline object per run. It filters a document through the operators in order and counts each
    limit. It reports "stop" when a limit is full, before the next document is pulled.
  - Every reader uses it: `runQuery`, `iterate` (`for await`), `paginate` and search.
  - The fast path (no filter) stays: the smallest limit is the page size.
- The cap: `filter` refuses the 257th operator; the start counts every operator (the terminal's limit too)
  and refuses more than 256, with Convex's messages. `limit`'s `n` is checked at the start with Convex's
  structure and serde's wording.
- Types: as Convex, `limit` is not in the public query types.

### 1.4 Divergences

None. `limit(0)` in `paginate` fails as a system error, as in Convex.

## 2. `db.table(name)`: the scoped reader and writer

### 2.1 How Convex does it

- `npm-packages/convex/src/server/database.ts` L79-110 and L404-460: `GenericDatabaseReaderWithTable` /
  `GenericDatabaseWriterWithTable`. `db.table(name)` returns:
  - a `BaseTableReader` (`get(id)`, `query()`);
  - in a mutation, a `BaseTableWriter` (also `insert(value)`, `patch(id, value)`, `replace(id, value)`,
    `delete(id)`);
  - `db.system.table(name)` is a reader of the system tables.
- `server/impl/database_impl.ts` L176-211 (`TableReader`, `TableWriter`): thin wrappers. Each method is the
  two-argument form with the table filled in:
  - `get(id)` is `db.get(table, id)`;
  - `query()` is `db.query(table)`, with its system / user check (``System tables can only be accessed
    from db.system.query().``);
  - `insert(v)`, `patch(id, v)`, `replace(id, v)`, `delete(id)` are the same as their two-argument forms:
    the backend checks that the id belongs to the table.
- A query's `db` is a reader: its `table()` has no write methods.

### 2.2 What an app observes

The same results and errors as the two-argument forms; `db.table(t).insert` is `undefined` in a query.

### 2.3 How bunvex does it

- `Tx.table(name)` returns a `TableReader` (`get`, `query`) or, in a writable transaction, a `TableWriter`.
  Each method calls the `Tx` method with the table (`get(table, id)`, `patch(table, id, v)`, …), so
  validation and errors are those of the two-argument forms.
- The reader view a query gets inside a mutation (`readerView`) gives a reader too.
- `db.system.table(name)` is `SystemReader`'s `get` / `query` for that table.
- Types: `GenericDatabaseReader.table`, `GenericDatabaseWriter.table`, `BaseTableReader`,
  `BaseTableWriter`.

### 2.4 Divergences

None.

## 3. Returning a query from a function

### 3.1 How Convex does it

`npm-packages/convex/src/server/impl/registration_impl.ts` L75-81 (`validateReturnValue`), called by
`invokeQuery` (L351) and `invokeMutation` (L71) on the handler's resolved result, before the result is
serialized:

- a `QueryInitializerImpl` or `QueryImpl` (what `db.query(...)` and its operators return) throws
  ``Return value is a Query. Results must be retrieved with `.collect()`, `.take(n), `.unique()`, or
  `.first()`.``
- The check is on the top-level value only, and it runs before the `returns` validator, which runs in the
  backend.

### 3.2 What an app observes

The function fails with that message (a JS error, so `Uncaught Error: …` in logs).

### 3.3 How bunvex does it

- Before: a query object went to value conversion and failed with a generic "not a supported value"
  message.
- Now: `Functions.invoke` checks the handler's result. A query object (a `TxQuery` of `db.query` or of
  `db.system.query`) throws Convex's message, before `returns` is checked.

### 3.4 Divergences

None.

## 4. `fetch`, timers and randomness in queries and mutations

### 4.1 How Convex does it

- `crates/isolate/src/environment/udf/mod.rs` L251-259 (`not_allowed_in_udf`): a user error with code
  `No<Name>InQueriesOrMutations` and the message ``Can't use <description> in queries and mutations. Please
  consider using an action. See https://docs.convex.dev/functions/actions for more details.`` It is the
  same text for queries and for mutations.
- Async ops (L356-365, `crates/isolate/src/environment/async_op.rs` L40-59):
  - `fetch()`: name `Fetch`, description `fetch()`. `fetch` is an async function in the runtime, so the
    error is a **rejected promise**, which the app can catch.
  - Timers (`npm-packages/udf-runtime/src/02_timers.ts`): `setTimeout` and `setInterval` return their id
    normally. Their sleep op (`void performAsyncOp("sleep", name, ms)`, L77) fails with name `Sleep` and
    description `setTimeout` or `setInterval` (no parentheses).
    - That rejection has no handler. The isolate checks unhandled rejections once the microtask queue
      drains, and the function fails with it (`crates/isolate/src/request_scope.rs` L508-524).
    - So a `try` around `setTimeout` does not help: the function fails all the same, with ``Can't use
      setTimeout in queries and mutations. …``.
  - `formData()`, `storage.store()` / `storage.get()` and streams are refused the same way; bunvex has no
    such paths in queries and mutations.
- Randomness:
  - `crypto.getRandomValues` and `crypto.randomUUID` are **allowed**. They draw from the execution's seeded
    PRNG, the same one as `Math.random` (`crates/isolate/src/ops/crypto.rs` L8-32, `provider.rng()`).
    `getRandomValues` above 65,536 bytes throws a TypeError, ``Byte length (N) exceeds the number of bytes
    of entropy available via this API (65536)``.
  - Cryptographic randomness (`crypto_rng`, `udf/mod.rs` L277-279) is refused: ``Can't use cryptographic
    randomness in queries and mutations. …``. Only `crypto.subtle` asks for it
    (`ops/subtle_crypto/mod.rs` L332, L401, L472; `crates/webcrypto/src/lib.rs` L474-540):
    - `generateKey`: always;
    - `encrypt`: RSA-OAEP only;
    - `sign`: RSA-PSS and ECDSA only.
    The subtle methods are async, so the error is a rejected promise. `digest`, `importKey`,
    `exportKey`, `verify`, `decrypt`, HMAC and Ed25519 signing work.
- At import time (`crates/isolate/src/environment/analyze.rs` L157-166, `udf/phase.rs`): `Math.random` and
  `getRandomValues` use the seeded PRNG; cryptographic randomness is ``Cannot use cryptographic randomness
  at import time``.

### 4.2 What an app observes

- `await fetch(...)` rejects with the message above; the app can catch it.
- `setTimeout(...)` / `setInterval(...)` return an id, and the function then fails with the message.
- `crypto.getRandomValues(buf)` and `crypto.randomUUID()` work and are deterministic per execution, as
  `Math.random` is.
- `crypto.subtle.generateKey(...)` and randomized encrypt / sign reject with the cryptographic-randomness
  message.

### 4.3 How bunvex does it

`packages/core/src/determinism.ts` replaces the globals once and looks up the running execution.

- Before:
  - `fetch` rejected, but with bunvex's own text: "Can't use fetch() in queries. Use an action instead."
  - `setTimeout` / `setInterval` **threw at the call**, so a `try` could catch them.
  - `crypto.getRandomValues` **threw**, where Convex allows it.
  - `crypto.randomUUID` and `crypto.subtle` were **not restricted**: a query got real randomness, so its
    result was not a function of its reads.
- Now:
  - `fetch` rejects with Convex's message (without the docs link; see below).
  - `setTimeout` / `setInterval` return an id and never run the callback. The error fails the execution
    (`failExecution`): it is thrown at the next store call and when the function ends, and it cannot be
    caught. That is the closest one process gets to Convex's "fails when the microtask queue drains".
  - `crypto.getRandomValues` fills the array from the execution's seeded PRNG, with Convex's 65,536-byte
    TypeError.
  - `crypto.randomUUID` builds a version-4 UUID from the same PRNG.
  - `crypto.subtle.generateKey`, `encrypt` (RSA-OAEP) and `sign` (RSA-PSS, ECDSA) reject with the
    cryptographic-randomness message. (Convex's `wrapKey` / `unwrapKey` are not implemented at all, in
    actions too: a separate gap, not this one.)
  - At import time, as before: seeded `Math.random`, and getRandomValues seeded as in Convex; subtle
    randomness is refused with Convex's import-time message.
- The messages drop Convex's docs link (the repository's rule: no Convex URLs in shipped strings), as
  elsewhere.

### 4.4 Divergences

None beyond the docs link, which the repository's rule already decides.

- The PRNG differs (sfc32, not ChaCha12). The bytes are random either way, and no app can rely on
  Convex's sequence.

## 5. An invalid auth token

### 5.1 How Convex does it

- `crates/local_backend/src/http_actions.rs` L165-169: an HTTP action whose `Authorization` header fails
  verification still runs, with `Identity::Unknown(Some(error))`.
- `crates/isolate/src/environment/action/task_executor.rs` L205-223: `getUserIdentity()` in that action
  throws the error.
- `crates/isolate/src/environment/udf/async_syscall.rs` L904-912: queries and mutations it runs see
  `tx.user_identity()`, which is `None` for `Unknown`, so null.
- `crates/isolate/src/environment/action/async_syscall.rs` L306-313: `ctx.runAction` passes the same
  identity (`propagate_component_auth`). The nested action's `getUserIdentity()` **throws too**.
- `/api/query`, `/api/mutation`, `/api/action` and the sync protocol refuse a bad token up front (401,
  `AuthError`), as bunvex already does (STUDY-27).

### 5.2 How bunvex does it

- STUDY-31 built the HTTP-action part: the request runs, `getUserIdentity()` throws the verification
  error, and `ctx.runQuery` / `ctx.runMutation` see null (`http-actions.test.ts`).
- The gap: `ctx.runAction` from that action built the nested action's context with no error, so the
  nested `getUserIdentity()` returned null. Now the error is passed on, as Convex passes the identity.
- The platform.md row was stale ("missing"); it is now done.

### 5.3 Divergences

None.

## 6. `schema.doc(table)`, `schema.id(table)`, `docValidator()`

### 6.1 How Convex does it

`npm-packages/convex/src/server/schema.ts`:

- `docValidator(tableName, table)` (L822-833) adds the system fields to the table's validator
  (`addSystemFields`, L772-797):
  - an object: `validator.extend({ _id: v.id(tableName), _creationTime: v.number() })`, so the system
    fields come after the table's own;
  - a union: each member, recursively;
  - `v.any()`: itself;
  - anything else throws ``Invalid validator for table "<t>": a table's documents must be objects, or a
    union of objects``.
- `SchemaDefinition.doc(tableName)` (L902-906) is `docValidator` of the schema's table.
  `SchemaDefinition.id(tableName)` (L916-921) is `v.id(tableName)`.
  - Both first check that the table is in the schema (`tableInSchema`, L844-860): ``Table "<t>" is not in
    this schema. Tables in this schema: a, b``.
- `TableDefinition.validator` is the table's document validator; `docValidator` reads it.

### 6.2 What an app observes

- Validators usable in `args` / `returns` that accept a whole document of the table.
- The error above for a table the schema does not have.

### 6.3 How bunvex does it

- `docValidator(tableName, table)` is exported from `bunvex/server` (`@bunvex/core` `schema.ts`). It uses
  the same rules on `TableDefinition.document`.
- `TableDefinition.validator` is added as Convex's name for the same validator.
- `defineSchema` returns an object that also has `doc(name)` and `id(name)`, with Convex's error.
  - The tables are kept from the definitions, as given.
  - The types give the document validator of each table (Convex's `DocValidator`).

### 6.4 Divergences and a gap found

- None in the helpers.
- A gap found while studying them: Convex's `schema.tables` is the record of `TableDefinition`s
  (`schema.tables.messages.validator`). bunvex's is a `Map` of the engine's declared tables, so
  `docValidator("messages", schema.tables.messages)` (Convex's own example) does not work on bunvex.
  - `schema.doc("messages")` does, and is what Convex recommends.
  - Making `schema.tables` a record touches the engine's every reader of it. It is recorded as a *missing*
    row in server-api.md, to build separately.

## 7. Registration guards: calling a function directly, importing functions in a browser

### 7.1 How Convex does it

`npm-packages/convex/src/server/impl/registration_impl.ts`:

- `dontCallDirectly` (L97-109): a registered query, mutation or action **is a function**. Called directly
  (`await foo(ctx, args)`), it prints a `console.warn` and runs the handler:
  ``Convex functions should not directly call other Convex functions. Consider calling a helper function
  instead. e.g. `export const foo = query(...); await foo(ctx);` is not supported. See
  https://docs.convex.dev/production/best-practices/#use-helper-functions-to-write-shared-code``
- `assertNotBrowser` (L134-152): at definition, when `window` is a real browser's (its getter is native
  code), `console.error` ``Convex functions should not be imported in the browser. This will throw an error
  in future versions of `convex`. …``. `window.__convexAllowFunctionsInBrowser` turns it off. JSDOM does not
  count.

### 7.2 What an app observes

- A registered function can be called directly, with a warning.
- Importing functions in a browser logs an error, and nothing else happens.

### 7.3 How bunvex does it

- Before: a registered function was a plain object; calling it threw `TypeError: foo is not a function`.
- Now:
  - `define` returns a function with the same properties (`kind`, `visibility`, `handler`, `args`,
    `returns`, the markers). Called, it warns and runs the handler.
  - At definition, the same browser check logs bunvex's message. The escape hatch is
    `window.__bunvexAllowFunctionsInBrowser`: the repository's rule forbids "convex" in names.

### 7.4 Divergences

- The escape-hatch flag's name (`__bunvexAllowFunctionsInBrowser`) and the messages' wording follow the
  repository's naming rule, as `BunvexError` does for `ConvexError`. No owner decision needed beyond that
  rule.

## 8. Tests

Each PR carries its tests and a sabotage check (the fix broken, the test seen failing):

- `.limit(n)`:
  - in chain order with filters, in `take`, `collect`, `for await`, `paginate` and search;
  - the read set stops at the document that fills the limit;
  - bad `n` and the cap's two messages;
  - a property test against a model of the pipeline.
- `db.table()`: every method against its two-argument form, in a query and in a mutation, and
  `db.system.table`.
- Returned queries: `db.query(t)`, `.withIndex(...)`, `.filter(...)` and `db.system.query(...)` returned
  from a query and from a mutation.
- Globals: each message; `setTimeout` caught still fails the function; seeded `getRandomValues` /
  `randomUUID` (deterministic per seed, different between executions); the subtle cases; actions keep the
  real globals.
- Bad token: an HTTP action's nested `runAction` throws on `getUserIdentity()`.
- Schema helpers: the validators accept and refuse as Convex's, the error for an unknown table, and
  `args` / `returns` with them.
- Registration: a direct call warns and runs; the browser check with a fake native `window`.

## 9. Measurements

`.limit` and the operator cap are on the query hot path, and `db.table()` adds an object per call. Their
PRs measure `take` / `collect` / `first` with and without filters, and `db.table(t).get` against
`db.get(t, id)`.
