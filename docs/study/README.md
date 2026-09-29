# Convex studies

bunvex is a rewrite of Convex for Bun. The goal is that an app behaves **the same** on bunvex as on Convex,
from the function API down to its guarantees. Where bunvex differs, the difference is deliberate and
written down.

So no Convex-equivalent feature is implemented from memory or from the docs alone. It starts with a
**study** of how Convex actually does it, read in the Convex source.

## The rule

Before implementing a feature that Convex has:

1. **Study it in the source.** Read Convex's implementation in
   [get-convex/convex-backend](https://github.com/get-convex/convex-backend): the Rust crates for the
   backend and `npm-packages/convex` for the client and function API. The public docs say what Convex
   promises; the source shows how it keeps the promise and where the edges are. Cite files
   (`crates/…/file.rs`) so a reader can check.
2. **Write the study** as `docs/study/STUDY-NN-<topic>.md` from [TEMPLATE.md](TEMPLATE.md), in the same PR
   as the code or in a PR before it. It covers:
   - how Convex does it;
   - what an app can observe (the contract we must match);
   - how bunvex does it;
   - every divergence and why.
3. **Divergences need the owner.** Matching Convex is the default and needs no approval. Anything else —
   a different format, a missing piece, an extra feature — is listed under *Divergences* and decided by
   the owner before it merges.
4. **Never copy Convex code.** Study it, then write bunvex's version from scratch (see [NOTICE](../../NOTICE)).
   Quoting a constant or a format description in a study is fine; pasting an implementation is not.

A study is not a spec. A spec (`docs/specs/`) records a bunvex design decision, such as the persistence
contract or the package layout. A study records what Convex does and how bunvex maps it. A study may lead
to a spec.

## Index

| Study | Topic | Status |
|---|---|---|
| [STUDY-01](STUDY-01-document-ids.md) | Document IDs (`_id`) and table numbers | accepted (C: as Convex) |
| [STUDY-02](STUDY-02-read-own-writes.md) | Read-your-own-writes inside a transaction | implemented (#3), retroactive |
| [STUDY-03](STUDY-03-deterministic-execution.md) | Deterministic queries and mutations | implemented (#4), retroactive |
| [STUDY-04](STUDY-04-table-and-index-metadata.md) | Table and index metadata (`_tables`, `_index`) | implemented (#6) |
| [STUDY-05](STUDY-05-index-keys-and-ordering.md) | Value order, index keys and system indexes | draft (retroactive): divergences await the owner |
| [STUDY-06](STUDY-06-transactions-and-occ.md) | Transactions, OCC, commit and retries | draft (retroactive): divergences await the owner |
| [STUDY-07](STUDY-07-query-semantics.md) | Query semantics (`withIndex`, `take`, `collect`, limits) | draft (retroactive): divergences await the owner |
| [STUDY-08](STUDY-08-cache-and-subscriptions.md) | Query cache and subscriptions | draft (retroactive): divergences await the owner |
| [STUDY-09](STUDY-09-persistence-layout.md) | Persistence layout and drivers | draft (retroactive): divergences await the owner |
| [STUDY-10](STUDY-10-documents-and-values.md) | Documents and values | draft (retroactive): divergences await the owner |
| [STUDY-11](STUDY-11-function-results-and-errors.md) | Function results and errors | draft (retroactive): divergences await the owner |

The inventory of everything Convex has, and bunvex's status on each item, is in [docs/parity](../parity/README.md).

Status values: *draft* → *decision pending (owner)* → *accepted* → *implemented (#PR)*.
