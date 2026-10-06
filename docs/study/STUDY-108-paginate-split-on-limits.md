# STUDY-108 — `paginate()` at a transaction limit: `SplitRequired`, and limit error codes

- **Status:** implemented
- **Convex source read:** `main` of get-convex/convex-backend (4577b9031), 2026-10-05
- **Related:** [STUDY-17](STUDY-17-paginate.md) (paginate), [STUDY-26](STUDY-26-sync-client.md) §8 (the paginated
  clients that split pages), [STUDY-07](STUDY-07-query-semantics.md) (read limits)

## 1. How Convex does it

**Limit errors carry an error code, which only the backend reads.** The transaction limits raise
`ErrorMetadata::pagination_limit(short_msg, msg)` (`crates/errors/src/lib.rs:420`, code `PaginationLimit`):

- `database/src/reads.rs:420-440`, `record_read_document`:
  - `TooManyDocumentsRead`, "Too many documents read in a single function execution (limit: N). …";
  - `TooManyBytesRead`, "Too many bytes read in a single function execution (limit: N bytes). …".
  - The count and size grow first, even when the check then throws.
- `reads.rs:460-470`, `record_indexed_directly`: `TooManyReads`, "Too many reads in a single function execution (limit: N). …".
  The interval is recorded before the check.
- `database/src/writes.rs:290-310`: `TooManyWrites` and `TooManyBytesWritten`.
- `database/src/query/mod.rs:771-784`: a page's own limits, `QueryScannedTooManyDocumentsError` and `QueryScannedTooMuchDataError`.

The code is not handed to a function. A syscall error reaches JS as `new Error(e.message)`
(`npm-packages/convex/src/server/impl/syscall.ts`, `performAsyncSyscall`), so an app sees only the message.
`is_pagination_limit()` is read in one place, `read_page_from_query`.

**`read_page_from_query`** (`crates/isolate/src/environment/udf/async_syscall.rs:1808-1870`) pulls documents with
`query.next_with_ts`. When that fails with a pagination limit:

- the page status becomes `SplitRequired`;
- if the query has no cursor yet, Convex fails with a plain `anyhow` error (a system error), "This should be
  impossible. Hit pagination limit before setting query cursor: …". The cursor is `None` only on a first page
  (no start cursor) before any document was read;
- otherwise the loop stops, and the page so far is returned. The continue cursor is `end_cursor.or_else(query.cursor())`;
  `isDone` is `cursor == End`; `splitCursor` is `query.split_cursor()`.

**Where the cursor is** when a limit hits (`database/src/query/index_range.rs:163-300`, `IndexRange::start_next`):

- `record_read_document` runs on a document before the cursor moves past it. So at a documents or bytes limit,
  the document over the limit is charged but not returned, and the cursor stays after the last one returned.
- The cursor then moves past the document, and `record_indexed_directly` records the read so far. At the
  read-interval limit (only the first record of a range adds an interval; later ones extend it), the page fails
  after the cursor moved: the page is empty and the cursor is *past* the first document.
- With no document in the range, the record happens before the cursor is set to the end. With no start
  cursor, that is the system error. With a start cursor, the page is empty and continues from it.
- Starting from an `End` cursor, the cursor is `End` before the record: an empty, done, `SplitRequired` page.

**The page's own limits** (`IndexRange`):

- `maximumRowsRead` / `maximumBytesRead` are enforced only without an end cursor (`enforce_limits =
  end_inclusive.is_none()`): a pinned page is read to its end.
- They are checked in `start_next`, before the next document is fetched, so that document is not read.
- The soft limits (`is_approaching_data_limit`) are 3/4 of `min(maximumRowsRead ?? 32 000, 32 000)` rows and of
  `min(maximumBytesRead ?? 16 MiB, 16 MiB)` bytes. They apply even with an end cursor. Past either, or past 6144
  documents in the page, and with no other status: `SplitRecommended`.
- **The split cursor** (`intermediate_cursors`) is the position of every document the index range returned: the
  ones a filter drops count too, the one over a limit does not. It is the middle one when there are more than
  two, on **every** reactive page, whatever its status.

## 2. What an app can observe

- A `paginate()` that hits a transaction read limit returns `{ page: <documents so far>, isDone: false,
  pageStatus: "SplitRequired", continueCursor, splitCursor }` instead of throwing. The function goes on, but its
  next read throws, because the counts already passed the limit.
- A first page that hits a limit before its first document: the request fails with the internal-error message;
  the function cannot catch it.
- Elsewhere a limit error is a plain `Error` with Convex's message. It has no `code` or `data` and no class of
  its own.
- The paginated clients (`usePaginatedQuery`) see `SplitRequired` and split the page; they never see the error.
- A pinned page ignores `maximumRowsRead` / `maximumBytesRead`, though its soft limits still recommend a split.
- `splitCursor` is set on any page that read more than two documents.

## 3. How bunvex does it

- **The mark.** The five limit errors in `Tx` (`countEgress`, `recordInterval`, and the write checks) are made by
  `paginationLimit(message)`. It returns a plain `Error`, remembered in a module-private `WeakSet`. Nothing
  shows on the error: no name, property or class. `isPaginationLimit(e)` is how `paginate` recognizes one.
- **`Tx.paginate`** pulls the stream by hand (so the page's limits are checked before the next document is
  read) and catches a pagination limit:
  - if there is no start cursor and no document was read, it throws `QueryCursorError` with Convex's message.
    That is a system error (`failExecution`; the client gets the internal-error message);
  - otherwise the status is `SplitRequired`, and the page ends at the last document read. Its read interval is
    recorded up to that document. The continue cursor is the end cursor if pinned, else after the last document
    read, else the start cursor.
  - **The read-interval limit.** bunvex records one interval per page, at its end; Convex records it with the
    first document. So when the transaction's interval budget is already spent before the page, `paginate` records
    the page's interval at its first document. That fails there, as Convex's does: the page is empty and the
    cursor is past that document. With no document, the record at the end of the range fails the same way.
  - Starting from an `end` cursor, a failing record gives an empty, done, `SplitRequired` page.
- **The page's limits**, as Convex's `IndexRange`:
  - none on a pinned page;
  - checked before reading the next document;
  - the soft limits from the transaction limits when the page sets none;
  - the split cursor from every document read, on any page that read more than two.

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| L1 | Limit error codes are not exposed to apps | Same as Convex: its `ErrorMetadata` codes stay in the backend | not a divergence (owner 2026-10-05: keep them internal) |
| L2 | `SplitRequired` on a transaction limit | Was missing; built to match Convex | owner 2026-10-05: match Convex exactly |
| L3 | Found here, undecided until now, matched to Convex (no decision needed): (a) a pinned page stopped at `maximumRowsRead`/`maximumBytesRead`; (b) `splitCursor` only with a page status, from the page's documents; (c) no soft limit without `maximumRowsRead`/`maximumBytesRead`; (d) the document after the page's row/byte limit was read and charged | bunvex's earlier paginate; Convex's `IndexRange` | DV-362, resolved to match Convex |

Not matched, and not observable:

- Convex's soft row count is the rows *fetched*, prefetch included. bunvex counts the rows read. They differ only
  by the prefetch slack at the 3/4 threshold.
- bunvex counts one read interval per index range read (no merging of overlapping ones). That is STUDY-07's
  read-set accounting, not this study's.

## 4b. Additions (beyond Convex)

None.

## 5. Tests

`packages/core/test/paginate-limits.test.ts`:

- the documents-read limit:
  - the page ends with `SplitRequired`;
  - the document over the limit is charged;
  - the function's next read throws the same plain `Error` (no class, no keys);
  - the continue cursor resumes at the next document;
  - the split cursor's halves make up the page;
- the bytes-read limit;
- the read-interval limit:
  - an empty page past the first document, as Convex's;
  - from an `end` cursor: done, `SplitRequired`;
- before any document:
  - a first page throws `QueryCursorError` with Convex's message;
  - a later page continues from its start, ascending and descending;
- a pinned page stopped by a limit continues at its end;
- other errors still fail the page;
- `maximumRowsRead` stops before reading (and charging) the next document;
- the split cursor is the middle document read, filtered out or not, with no status;
- `SplitRecommended` past 24 000 rows with no page limit;
- with the real 32 000 limit: a page of 32 000 after one read is split at 31 999, and paging goes on.

`packages/core/test/paginate.test.ts`: the pinned-page test now expects Convex's reading to the end
(`SplitRecommended`, the split covering the page).

`packages/server/test/paginate-limits.test.ts`:

- from an app's query, the page is split at the limit;
- outside paginate, the app sees `Error` with Convex's message and no keys;
- before any document, HTTP 500 with the internal-error message, though the function catches.

The React pagination tests (`packages/sync-e2e/react`, which split pages) pass unchanged.

There is no oracle against the `convex` package: its JS side passes the backend's page through untouched
(`query_impl.ts` `paginate`), so the behaviour is all in the backend.

Sabotage checks, each caught:

- P1, paginate ignores limit errors: 8 fail;
- P2, limit errors not marked: 8 fail;
- P3, no system error before any document: 2 fail;
- P4, page limits on a pinned page: 1 fails;
- P5, split cursor only with a status: 1 fails;
- P6, no 3/4 on the soft row limit: 1 fails;
- P7, the read-interval limit not at the first document: 1 fails;
- P8, the page row limit off by one: 2 fail;
- P9, a page with no document continues from the range's start: 1 fails (descending);
- P10, the error given a name of its own: 2 fail;
- P11, at the end cursor the read limit fails the page: 1 fails.

Measurement: pages of 100 over 10 000 documents, the memory store, 20 runs, three interleaved before/after
rounds.

- Plain: before 245–283 µs per page, after 260–302 µs.
- With a filter (half the documents): before 519–603 µs, after 542–615 µs.

The ranges overlap. The extra work per page is one split cursor sealed whenever more than two documents were
read (as Convex) and a key kept per document read.

## 6. Open questions

None.
