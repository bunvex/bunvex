# STUDY-17 — `.paginate()`, cursors and reactive page boundaries

- **Status:** implemented (#42)
- **Convex source read:** commit `4577b9031`
  - `crates/isolate/src/environment/udf/async_syscall.rs` (`query_page`, `read_page_from_query`);
  - `crates/common/src/query.rs` (`Cursor`);
  - `crates/database/src/query`;
  - `npm-packages/convex/src/server/pagination.ts`.
- **Related:** [STUDY-15](STUDY-15-query-filter.md), [STUDY-16](STUDY-16-query-chaining.md)

## 1. How Convex does it

- **Call and result:** `paginate({ numItems, cursor, endCursor?, maximumRowsRead?, maximumBytesRead? })`
  returns `{ page, isDone, continueCursor, splitCursor, pageStatus }`.
- **A cursor** holds a position — *after* an index key, or *end* — plus the query's fingerprint. It is
  encrypted with the instance secret.
  - A tampered cursor fails with `InvalidCursor: Failed to parse cursor`.
  - A cursor from another query fails with "…this cursor is from a different query.", as a `BunvexError`
    whose data is `{isBunvexSystemError: true, paginationError: "InvalidCursor"}` (Convex:
    `isConvexSystemError`).
- **Filling a page:** without `endCursor`, the page reads until `numItems` documents pass the filters.
  - A full page stops there, so its cursor is "after the last document" and `isDone` is false, even when
    nothing follows.
  - Reaching the end of the range gives the cursor `end` and `isDone` true.
- **With an `endCursor`,** the page returns exactly the range up to it. The client sends one (via
  `usePaginatedQuery`), or a subscription re-run takes it from the previous run's journal
  (`prev_journal.end_cursor`). That keeps page boundaries stable while documents are inserted or
  deleted.
- **`maximumRowsRead` / `maximumBytesRead`:**
  - reaching either stops the page, with `pageStatus: "SplitRequired"`, except on a page pinned by an end
    cursor, which is read to its end;
  - going past 3/4 of either (of the transaction's read limits when they are not set), or past 6144
    documents, gives `"SplitRecommended"`;
  - `splitCursor` points at the middle document read, on any page that read more than two (STUDY-108).
- **A transaction read limit** hit while reading ends the page with `"SplitRequired"` instead of the error
  (STUDY-108).
- **Errors:**
  - "Must request at least 1 document while paginating";
  - "Requested too many items: N" (more than 32 000);
  - "maximumRowsRead and maximumBytesRead must be greater than 0";
  - on the JS side, "`options.numItems` must be a positive number.";
  - only one paginated query per function ("…ran multiple paginated queries…").
- **Validators:** `paginationOptsValidator` and `paginationResultValidator` are exported from
  `convex/server`.

## 2. What an app can observe

The result shape and flags, the cursor behaviour and its errors, stable page boundaries in subscriptions,
the split fields, and the validators.

## 3. How bunvex does it

- **`packages/core/src/cursor.ts`:** Convex's format (DV-73 resolved): the `InstanceCursor` proto
  (instance name, position, fingerprint) sealed with AES-128-GCM-SIV (`aead.ts`) under the key derived from
  the instance secret for "cursor", with a zero nonce (the same position gives the same cursor), version 7,
  hex. The secret is the `Engine` option `instanceSecret`, or else the one generated once and stored in
  `_instance` (D2). Sealing and opening one cursor costs about 7 µs (an HMAC cost 1.5 µs).
- **`Tx` query `.paginate()`:**
  - streams the sub-range between the cursors, with filters, the transaction's own writes, the limits and
    the split fields as in §1;
  - records the range it covered as its read-set;
  - sets the journal's end cursor.
- **`Engine.queryTracked(body, journal)`** takes the previous journal, and `Subscriptions` keeps one per
  subscription.
- **`@bunvex/server`** exports `paginationOptsValidator` and `paginationResultValidator`.

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| D1 | Cursors are signed (HMAC), not encrypted: the index key position is visible to a client who decodes base64 | Tampering is refused all the same; encryption needs the key broker (admin keys, phase 3) | Decided (owner, 2026-10-01): match Convex. Built: cursors sealed as Convex's keybroker seals them (`cursor.ts`; DV-73 resolved) |
| D2 | Without `INSTANCE_SECRET`, a random secret is generated on first start and stored with the data (system table `_instance`), as Convex's self-hosted image does (`self-hosted/docker-build/read_credentials.sh`: the env var, else the stored secret, else a new random one that is then saved). Convex saves it in a file of its data directory; bunvex saves it in the store, because the data may live in a remote database | accepted: option D (owner, 2026-09-30) |
| D3 | The fingerprint covered table, index, range and order, not filter expressions | Filters were evaluated as closures, with no serialized form | accepted (#42); re-studied 2026-10-04 (§4.1): **resolved to match Convex** (owner, 2026-10-04, option b) |
| D4 | `InvalidCursor` errors are plain errors, without Convex's error `data` | The error-data class lands with the errors work (track B, #32) | resolved (STUDY-26 P1): a cursor of another query is a `BunvexError` with `{isBunvexSystemError: true, paginationError: "InvalidCursor"}`; a cursor that does not parse stays a plain error, as in Convex |

### 4.1 D3, re-studied (owner, 2026-10-04)

**Convex.** A paginated query's fingerprint is a SHA-256 of the whole query's JSON (its source: index, range,
order; and its operators in order: every `filter` expression and `limit`) plus the index's fields
(`Query::fingerprint`, crates/common/src/query.rs:970-990). It is computed only when paginating
(crates/database/src/query/mod.rs:362-370) and compared with the start cursor's and the end cursor's
(mod.rs:381-384, 396-400); a mismatch is `invalid_cursor()` (mod.rs:786): "InvalidCursor: Tried to run a query
starting from a cursor, but it looks like this cursor is from a different query.", data
`{isConvexSystemError: true, paginationError: "InvalidCursor"}`. The paginated clients treat it as "start over":
the page is dropped and pagination restarts from the first page (react/use_paginated_query2.ts:301-307,
browser/sync/paginated_query_client.ts:206). A `filter` is serialized once, when the query is built: the
predicate runs against the filter builder and returns an expression tree (`filter_builder_impl.ts`:
`{ $eq: [{ $field: "n" }, { $literal: … }] }`, literals as Convex JSON), pushed as `{ filter: <tree> }`
(query_impl.ts:225-240). "The same filter" therefore means the same tree with the same literal values.

**bunvex before.** `filter(predicate)` also runs the predicate once against a builder (tx.ts), but the tree's nodes
held only an `evaluate(doc)` closure: no serialized form, so the fingerprint (`queryFingerprint`, cursor.ts) covered
table, index, range and order only.

**How big the gap is.** The arguments of a paginated query are not what this is about: a client paginating with
new arguments starts a new paginated query (its pages are keyed by the arguments), and a range built from them is
in the fingerprint already. The gap shows only when the same query, with a cursor, runs with a *different filter*:
- **a filter computed from data the query reads** (Convex's own example at mod.rs:350-361, for a range): a page
  re-run after that data changed. Convex answers `InvalidCursor` and the client restarts from the first page;
  bunvex kept the page's boundaries and filtered them with the new filter;
- **manual pagination** (`paginate` called by hand, an HTTP client) handing a cursor to a query with another
  filter: Convex refuses it; bunvex continued from that position.
In neither case did bunvex return wrong documents: the positions are positions in the same index range, and every
document returned passed the current filter. What differs is what an app sees: no error, and pages that are not
restarted.

**Options.**
- (a) **Accept** the divergence: harmless for correctness (above), but observably different from Convex, and an
  app (or the paginated clients) never sees the `InvalidCursor` that Convex would give.
- (b) **Match Convex** (proposed, built in this PR): each filter node also carries its serialized form, built by
  the filter builder exactly as Convex's (`$field`, `$literal` with Convex JSON values, `$eq` … `$mod`, `$neg`,
  `$and`, `$or`, `$not`); the fingerprint appends the serialized operators (`{ filter }`, `{ limit }`, in order).
  A query with no operator keeps the fingerprint it had, so its cursors stay valid after the upgrade; a filtered
  query's outstanding cursors are refused once, and the clients restart those pages (as for any `InvalidCursor`,
  DV-250). Cost: 0.67 → 1.08 µs per filtered `paginate` call; each filter node builds a small JSON object.
- (c) **The predicate's source text** (`predicate.toString()`): cheap, but blind to the values a closure
  captures (the common case, `q.eq(q.field("channel"), args.channel)`), and changed by minification: it would
  refuse cursors that are fine and accept ones that are not. Rejected.

**Recommendation:** (b), matching Convex. **Decided:** (b) (owner, 2026-10-04).

## 5. Tests

`packages/core/test/paginate.test.ts` covers:

- paging through a range, including the full-page-at-the-end case and paging past the end;
- descending order with a range and a filter;
- cursors from another query, tampered cursors, and cursors from another instance;
- the argument errors, and one paginated query per function;
- `maximumRowsRead` → `SplitRequired` with a `splitCursor`, then continuing;
- an explicit `endCursor`;
- a subscribed page that keeps its boundary.

Sabotage: without the journal, the subscription test fails.
