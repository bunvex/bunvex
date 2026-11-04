# STUDY-204 — Components in snapshot export and import
<!-- index: Components in snapshot export and import (STUDY-152 step 10, DV-215): the ZIP's `_components/<name>/` prefixes, import into a component path, streaming export's `_component` | study; PR 1 (export) built -->

STUDY-152 step 10. DV-215 accepted "export has only the root; a ZIP with `_components/…` is refused on import"
until bunvex had components (owner, 2026-10-02). Components now exist (STUDY-152 steps 1–7), and bunvex's own
auth component keeps its accounts and password hashes in a component's tables. The 2026-11-03 production audit
(B6) found what this leaves: an export of a deployment with components omits those tables without a word, so a
backup restores an app whose users are gone. This study takes the step up again. It builds on STUDY-152 §5 and
STUDY-42.

## 1. How Convex does it

### Export (`crates/exports/src/lib.rs`)

- **Which namespaces.** `export_inner` (`:127-235`) takes every active user table of every namespace from the
  snapshot's table registry (`iter_active_user_tables`) and every component's path from
  `snapshot.component_ids_to_paths()` (`crates/database/src/snapshot_manager.rs:550`). That is
  `ComponentRegistry::all_component_paths` (`crates/database/src/component_registry.rs:151-174`): every
  `_components` row whose chain of parents reaches the root, whatever its state (unmounted ones included), plus
  the root, always.
- **The prefix.** `get_export_path_prefix` (`:476-487`) writes `_components/<name>/` for each segment of the path,
  so `a/b` becomes `_components/a/_components/b/`. Under each prefix the layout is the root's.
- **Order.** `construct_zip_snapshot` (`:330-473`):
  1. every namespace's `_tables/documents.jsonl`, in `ComponentId` order (the root first, then the children by
     id);
  2. every user table of every namespace, smallest first by `total_size`; a table whose namespace has no path is
     skipped with a log line;
  3. with `include_storage`, each namespace's `_storage` (metadata, then the files), last because it is the
     slowest.
- **Each namespace's `_tables`** (`write_tables_table`, `:236-267`) lists only that namespace's tables, in
  table-number order, at the namespace's own numbers.
- **Storage size limit.** `write_storage_table` (`crates/exports/src/export_storage.rs:82-112`) adds every
  namespace's file sizes into one running `file_storage_size`, and `ensure_file_storage_export_size` checks that
  total against the 1 TiB limit.
- **Progress messages** append `in_component_str` (`crates/common/src/components/component_path.rs:115-121`):
  `""` for the root, ` in '<path>'` otherwise, as in "Backing up messages in 'counter'".
- **The request's `component` argument** is stored on the `_exports` row and never used: an export always holds
  every component (STUDY-152 §5).

### Import (`crates/application/src/snapshot_import/`)

Summarized from STUDY-152 §5, which cites the files:

- The `_components/<name>/` prefixes of a ZIP entry are peeled from the right and appended to `--component`'s path
  (`parse.rs:105-113, 324-401`).
- Missing components and their parents are created **unmounted**, with a synthetic definition
  (`prepare_component.rs:39-133`).
- Table numbers are kept per namespace and ids are not remapped. `_storage` goes to that namespace's
  `_file_storage`.
- `--replace-all` appears to clear the user tables of every namespace (C5 in STUDY-152: to confirm on the binary
  before matching).

### Streaming export

Every value carries `_component` (`""` for the root). Selections can be by table, by component, or an exact map.
`json_schemas?byComponent=true` is also there (STUDY-152 §5).

## 2. What apps observe

- A ZIP export of a deployment with components has each component's tables, files and `_tables` under
  `_components/<name>/`. Restoring it brings back the components' data: for an app using an auth component, its
  users.
- `npx convex import` of such a ZIP recreates each component's tables, creating unmounted components where the
  target has none.

## 3. How bunvex does it

### PR 1: export (this PR)

`ExportService.run` (`packages/server/src/exports.ts`) does the following:

- reads `allComponentPaths` at the export's snapshot (bunvex's `all_component_paths`, the same rule: the root
  always, each component whose chain reaches the root, any state);
- keeps the namespaces the catalog has (`catalog.components`), sorted with the root first and then by id;
- writes Convex's order: every namespace's `_tables`, then every table of every namespace (each compressed first,
  then smallest first, as the root's already were), then each namespace's `_storage`;
- reads a component's documents and files in its namespace (`db.inComponent`);
- applies the 1 TiB file limit to the total of all namespaces;
- adds ` in '<path>'` to the progress messages.

Import is unchanged in PR 1: a `_components/` entry is still refused, now with a message that says import into
components is not built yet. A backup is complete before it can be restored by bunvex, rather than restorable and
silently incomplete.

### PR 2: import

`_components/` prefixes become a component path, appended to `componentPath` (`/api/import`, the CLI's
`--component`). Each table is imported into that namespace. Missing components are created unmounted, as Convex's
`prepare_component`. `--replace-all` follows C5 once confirmed. The parse in `import-parse.ts` carries each table's
path; `imports.ts` creates and activates the hidden tables in that namespace. Its own study section is added with
the PR.

### PR 3: streaming export

`_component` is set from the document's namespace. Selections by component, and `byComponent` schemas, are added
too. A non-root selection stops returning nothing.

## 4. Divergences

None new. DV-215 narrows with PR 1, to import (and streaming export) only, and is resolved by PR 3.

## 5. Tests (PR 1)

All in `packages/server/test/exports.test.ts`. Its `addComponents` sets up components the way a push leaves them:
`counter` and `second` under the root and `inner` under `counter`, each with its own `messages`, and `counter` with
`counters` too. Each table holds one document, written in its own namespace.

- **Tables.** Each namespace's `_tables` comes before any table, the root's first. Every component table is under
  its prefix, the nested one under `_components/counter/_components/inner/`. A component's `_tables` lists its own
  tables at its own numbers, and each namespace's documents are its own.
- **Files.** A file in `counter`'s `_file_storage` is under `_components/counter/_storage/`, its metadata just before
  it, after every table. Each namespace has its own `_storage/documents.jsonl`.
- **Sabotage.**
  - The export as it was on `main`: both tests fail (no `_components/` entries).
  - A component's table read in the root's namespace: both tests fail.
