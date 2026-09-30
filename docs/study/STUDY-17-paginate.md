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
  - reaching either stops the page, with `pageStatus: "SplitRequired"`;
  - going past 3/4 of either, or past 6144 documents, gives `"SplitRecommended"`;
  - `splitCursor` then points at the middle of the page.
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

- **`packages/core/src/cursor.ts`:** the same content (position + fingerprint), base64url-encoded and
  signed with HMAC-SHA256 under the instance secret: the `Engine` option `instanceSecret` (`INSTANCE_SECRET`
  in the bench server), or else the one generated once and stored in `_instance` (D2).
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
| D1 | Cursors are signed (HMAC), not encrypted: the index key position is visible to a client who decodes base64 | Tampering is refused all the same; encryption needs the key broker (admin keys, phase 3) | owner |
| D2 | Without `INSTANCE_SECRET`, a random secret is generated on first start and stored with the data (system table `_instance`), as Convex's self-hosted image does (`self-hosted/docker-build/read_credentials.sh`: the env var, else the stored secret, else a new random one that is then saved). Convex saves it in a file of its data directory; bunvex saves it in the store, because the data may live in a remote database | accepted: option D (owner, 2026-09-30) |
| D3 | The fingerprint covers table, index, range and order, not filter expressions | Filters are closures here, not a serialized expression | accepted |
| D4 | `InvalidCursor` errors are plain errors, without Convex's error `data` | The error-data class lands with the errors work (track B, #32) | resolved (STUDY-26 P1): a cursor of another query is a `BunvexError` with `{isBunvexSystemError: true, paginationError: "InvalidCursor"}`; a cursor that does not parse stays a plain error, as in Convex |

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
