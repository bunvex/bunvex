# STUDY-139 — bunvex as a product, Convex as the oracle

- **Status:** the principle and P1–P7 accepted (owner, 2026-10-08); to be built one PR per group (P1–P3, P4, P5, P6, P7). P1–P3 built (#525); P4 (#526), P5 (#527), P6 (#528) and P7 (#529) in review.
- **Convex source read:** reference `d8bdde0` (`docs/parity/upstream.md`), npm `convex` 1.46.0.
- **Related:** [STUDY-133](STUDY-133-persistence-layout-identical.md) (identical layout, cross-open tests),
  [STUDY-23](STUDY-23-sync-protocol-v1.md) P8 (DV-225), [STUDY-67](STUDY-67-http-function-api.md) H12 (DV-315),
  [STUDY-42](STUDY-42-import-export.md) (import and export), [STUDY-138](STUDY-138-following-convex.md)
  (following Convex), DV-414.

## 1. The principle (owner, 2026-10-08)

1. **bunvex is its own product, versioned from 0.x** (`0.1.0-alpha.0` today). In production a deployment runs
   bunvex's server with bunvex's client, CLI and packages.
2. **Convex is the oracle, not a production target.** Its official client, its binary and the stores it writes
   are used in tests (differential tests, the cross-open tests of STUDY-133) to compare behaviour and find bugs.
   Nobody is expected to run Convex's client against a bunvex server, or to point one binary at the other's
   store, in production.
3. **Migrating from Convex is export, then import**: an app exports its Convex deployment and imports the ZIP
   into bunvex, which builds every index again. That path is a production path; the cross-open is a test tool.

What follows from it:

- bunvex matches what an app **observes** on Convex at the reference and after (STUDY-138's bumps). It does not
  carry what Convex keeps only for **older** clients, older formats or older stores: compatibility starts at the
  reference and goes forward.
- bunvex **writes** only current formats. It reads only what bunvex wrote, what the export/import path brings,
  and what the oracle tests need.
- A new study asks, for each Convex compatibility path it meets: is it there for something older than the
  reference? If so, bunvex leaves it out unless an oracle test needs it.

## 2. What exists today only for older Convex clients, formats or stores

Found on `main` on 2026-10-08.

| # | What | Where | Serves |
|---|---|---|---|
| A1 | The client announces Convex's client version (`1.46.0`) in the sync URL and the `Bunvex-Client` header, not its own (DV-225) | `packages/client/src/version.ts` | the server's version gates below |
| A2 | Convex's deprecation thresholds: an npm, CLI or actions client at 0.19.1 or older is refused (400 `ClientVersionUnsupported`); python 0.2.0 / 0.0.2, rust 0.0.1 (DV-315) | `packages/server/src/client-version.ts` | Convex's old clients |
| A3 | Transition chunks only for an npm client at 1.28.0 or later (`MIN_CLIENT_VERSION_FOR_TRANSITION_CHUNKS`) | `packages/server/src/sync.ts` | Convex's clients before 1.28 |
| B1 | Reading a code package Convex deployed (a zip): a zip reader (STUDY-133 §12 M10) | `packages/server/src/code-store.ts` (`unzip`, `readZipPackage`) | bunvex redeploying over a store the Convex binary wrote (cross-open) |
| B2 | MySQL documents in Convex's v1 encoding (LZ4 with Convex's dictionary): read always, written with `MYSQL_DOCUMENT_ENCODING=1` (DV-414) | `packages/persistence/src/lz4.ts`, `mysql-documents.ts` | a MySQL store the Convex binary wrote |
| C1 | A store from before the `search_index_segments` global keeps its rows' states once (STUDY-133 PR 9) | `packages/core/src/search-segments.ts` (`load`) | bunvex stores older than today |
| C2 | `_index_worker_metadata` rows holding a document id (before STUDY-133 §12 M7) are still read | `search-segments.ts` (`loadForwarded`) | bunvex stores older than today |

Not in the list, because they serve the oracle tests or what an app observes:

- What bunvex **writes** so the Convex binary can open a bunvex store (STUDY-133: the four empty cloud tables,
  every table in the summary checkpoint, Int64 integers in search rows, …): cheap, and the cross-open tests rest
  on it.
- Behaviour an app sees (`_id` shapes, argument bytes, retention, audit rows, schema validation attempts, Blob
  types, error texts): the point of the project.
- An unreadable search row is ignored and its index rebuilt: the generic handling of any unknown row.

## 3. The migration path: export from Convex, import into bunvex

Import is built (STUDY-42): the ZIP's `"uniform"` encoding, files, resume after a restart, retries (DV-220,
DV-221). Gaps for a migration:

- **No test imports a ZIP the Convex binary exported.** The differential harness has the binary; a test that
  deploys an app on Convex, writes documents, files and scheduled jobs, exports, imports the ZIP into bunvex and
  compares the data would cover the production path end to end.
- Components (`_components/…` in a ZIP) are refused until components (DV-215).
- The legacy inferred-schema ZIP encoding is refused (DV-219). Convex at the reference writes `"uniform"`, so
  under §1 this stays as is.

## 4. Decisions to take

| # | Proposal | Why | Decision |
|---|---|---|---|
| P1 | The client announces **its own version** (`0.1.0-alpha.0`, from its `package.json`) in the sync URL and the header. Revisits DV-225 | §1.1. It needs P2 and P3, or the server refuses it (0.1.0 ≤ 0.19.1) and never chunks for it (0.1.0 < 1.28.0) | **accepted** (owner, 2026-10-08); built (#525) |
| P2 | The server no longer refuses clients by Convex's deprecation thresholds (A2); a header that does not parse is still 400 `InvalidClientVersion`. bunvex's own thresholds start empty. Revisits DV-315 | Those thresholds are Convex's old clients; bunvex's clients start at 0.x | **accepted** (owner, 2026-10-08); built (#525) |
| P3 | The server always sends big transitions in chunks (A3) | Every client bunvex supports (its own, and Convex's 1.46.0 in tests) takes them | **accepted** (owner, 2026-10-08); built (#525) |
| P4 | Remove the zip reader (B1). A package bunvex cannot read is ignored with a log line, and the next `deploy` replaces it, as the cross-open tests do | Only the cross-open uses it, and it works without | **accepted** (owner, 2026-10-08) |
| P5 | Remove Convex's MySQL v1 encoding (B2): only v0 is read and written, and `MYSQL_DOCUMENT_ENCODING` goes. Revisits DV-414 | Only a MySQL store the Convex binary wrote has v1; the cross-open tests use SQLite | **accepted** (owner, 2026-10-08) |
| P6 | Remove C1 and C2 | bunvex is alpha with no deployed stores to carry | **accepted** (owner, 2026-10-08) |
| P7 | Add the export-from-Convex, import-into-bunvex differential test (§3) | The production migration path, tested against the oracle | **accepted** (owner, 2026-10-08) |

## 5. The rule, for every study

Added to `CLAUDE.md`: bunvex matches what an app observes on Convex from the reference on; it does not build
what Convex keeps only for older clients, formats or stores; the Convex client, binary and stores are test
oracles; migration is export and import.
