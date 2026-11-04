# STUDY-204 — Components in snapshot export and import
<!-- index: Components in snapshot export and import (STUDY-152 step 10, DV-215): the ZIP's `_components/<name>/` prefixes, import into a component path, streaming export's `_component` | built: PR 1 (export), PR 2a (hidden tables by namespace), PR 2b (import), PR 3 (streaming export, data sync); Q1 open -->

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

### PR 2a: hidden tables in a component's namespace

Convex's import creates, activates and deletes tables in any namespace (`TableModel` per namespace,
`activate_tables`). In bunvex, `Engine.createHiddenTable` and `activateTables` worked in the root's namespace only.
They now take the table's namespace:

- `createHiddenTable` takes `namespace`. Numbers, names and `copyIndexesOf` are that namespace's, and the table is
  installed in that component's catalog.
- `activateTables` makes a hidden table replace the active table of its name in its own namespace, and takes
  `{ name, namespace }` for the tables it deletes.
- The tables a component replaces or deletes join the root's `deleting`, which the deletion worker empties, as
  `buildCatalog` puts them (`Catalog.withTableStatesAcross`).
- Staged validators are invalidated in the table's own namespace.
- Hidden-table cleanup reaches every namespace, as Convex's `cleanup_hidden_tables` does, since it walks the global
  `_tables` (`crates/application/src/system_table_cleanup/mod.rs:219-258`). STUDY-152 step 1 had kept it to the
  root's, because a component's catalog could not drop a table then.

Tests (`packages/core/test/hidden-tables.test.ts`):

- A component's hidden table, at the component table's number, is invisible to the root's catalog and stays hidden
  across a restart.
- Activating it, with another table of the component deleted by name, replaces only the component's `items` and
  deletes only its `other`. The root's tables of the same names are untouched, and the replaced tables are purged.
- A stale hidden table in the component is dropped.

`component-namespaces.test.ts` now expects a component's stale hidden table to be dropped.

Sabotage, each making the new test fail:

- The replaced table looked up in the root's namespace.
- The catalog updated with the root-only `withTableStates`.
- The cleanup kept to the root's again.

### PR 2b: import

`ImportService` (`packages/server/src/imports.ts`) and its parse (`import-parse.ts`) work per namespace:

- **Parse.** Each ZIP entry's `_components/<name>/` prefixes are peeled from the right (Convex's
  `COMPONENT_NAME_PATTERN`, `parse_component_path`). A name that is no identifier fails with
  `InvalidComponentName`: "component name '<name>' invalid: …". What is left before them, such as a folder the ZIP
  was made in, is ignored. `uniform` and the legacy schema are keyed by path and name.
- **`componentPath`.**
  - `/api/import` and `finish_upload` take Convex's `componentPath` (`ComponentPath::deserialize`: a name that is no
    identifier is 400 `InvalidComponentPath`).
  - It is stored on the `_snapshot_imports` row (`component_path`, null for the root's), and every entry's path is
    appended to it.
  - `bunvex import --component <path>` sends it, as `npx convex import --component` does.
- **Components.**
  - The import's own component is prepared when the upload is parsed (Convex's `parse_import`). Every other
    namespace the import names is prepared before its tables.
  - A missing component, and its parents first, is created **unmounted**, as Convex's
    `prepare_component_for_import` / `create_unmounted_component` do:
    - its own namespace (`initializeComponentNamespace`);
    - a `childComponent` definition whose path is the component path;
    - its `_components` row under its parent's.
  - The root's rows are written first if no push ever wrote them (`ensureRootComponent`).
- **Confirmation.** Changes are keyed by (component path, table), ordered by path (the root's first, then the names
  in turn) and then by name. A component's rows come under a `Component <path>` line, as `confirmation.rs` chunks
  them. Each checkpoint carries `component_path`.
- **Run.** Each namespace gets its own table numbers (`assign_table_numbers`), hidden tables (PR 2a), number checks
  (`validate_prepared_table_numbers`), conflict messages with ` in '<path>'`, and schema constraints. All hidden
  tables are activated in one commit. Progress messages follow Convex's: `Importing "t" in 'c'` and
  `Imported "t" in 'c' (n documents)`, with the in-between batch messages bare. A namespace's `_storage` files are
  stored into its own `_file_storage`.
- **`--replace-all`.** It deletes the tables the import does not have in **every** namespace that has a component
  path. This is C5, confirmed in the source: `finalize_import`'s `to_delete` (`mod.rs:1075-1100`), and the
  confirmation lists them (`confirmation.rs:108-127`). Each namespace's active-schema tables become empty ones
  (`initial_schemas`, `mod.rs:1276-1288`).
- **Audit event.** `snapshot_import`'s `table_names` and `table_names_deleted` are grouped by component as Convex's
  `audit_log_table_names`: the first 20 in (path, name) order, `{component, table_names}` per path. An empty set is
  `[]`, where bunvex wrote `[{component: null, table_names: []}]`.
- **Hidden-table resume.** The `hidden_tables` entries record their component.

What stays different: a component's documents are checked against its own active schema, with its `v.id`s named by
its catalog as it is. The root's are named by the tables as they will be once the import is activated (Convex's
`ImportSchemaConstraints` takes the as-will-be mapping for every namespace). This only matters for a component whose
schema points at a table the same import renumbers. It is left as an open question (Q1).

Tests:

- `packages/server/test/imports.test.ts`, "components (STUDY-204)":
  - An export of a deployment with `counter`, `second` and the nested `inner` (each with documents, plus a file in
    `counter`) is imported into an empty deployment. Checked: the confirmation per component, with every
    namespace's `_storage`, and the checkpoints with `component_path`. Each component is created unmounted under its
    parent. Documents, ids and table numbers are the same, namespace by namespace, and the root's has none. The
    file's id and UUID are kept, and its bytes are stored again.
  - `componentPath`: a JSON Lines table appended into `second`, and a table imported into a component that does
    not exist yet (`second/made`), which is created.
  - `replaceAll` with a ZIP that has only `counter/messages`: the root's other table and `second`'s tables are
    deleted, `counter`'s `counters` too, and `counter`'s `messages` is replaced.
  - A component name that is no identifier is refused.
- `packages/cli/test/import.test.ts`: `--component workflow/workpool` creates both, unmounted, and imports into
  `workpool`'s namespace. A name that is no identifier is the deployment's 400.
- `audit-log.test.ts`: the deleted tables of an import that deletes none are `[]`.

Sabotage, each making a test fail:

| Sabotage | Tests that fail |
|---|---|
| Component paths not parsed | the round trip and `replaceAll` |
| `replaceAll` kept to the import's namespaces | `replaceAll` |
| `--component` not sent | the CLI test |

### PR 3: streaming export and data sync

Convex's streaming export (`crates/local_backend/src/streaming_export.rs`, `crates/database/src/database.rs`) and data
sync (`crates/streaming_export/src/lib.rs`) cover every namespace with a component path. A table in an orphaned
namespace is skipped (`legacy_streaming_export_table_filter`). bunvex now does the same in
`packages/server/src/streaming-export.ts` and `data-sync.ts`:

- **`list_snapshot` and `document_deltas`.**
  - They walk the user tables of every namespace in `componentPathsAt` (`all_component_paths`, read at the snapshot,
    or at the upper bound for deltas), by tablet.
  - `_component` is the table's component path. The selection is looked up by that path, so `component=counter`
    and `tableName` with `component` select inside it.
  - A snapshot whose component paths are out of retention is `SnapshotTooOld`, as the read of its documents.
- **`json_schemas`.**
  - It covers every namespace, the root's first, then each component in `ComponentId` order (by its id's internal
    bytes).
  - Each table is described from its namespace's shapes, and when the shape is not an object, from its namespace's
    active schema.
  - With `byComponent`, each component path is a key, present even with no tables. Without it, everything goes in
    one map, a later component's table replacing a same-named one, as Convex's loop over one `out` does.
- **`get_table_column_names`.** `byComponent` maps each component path that has user tables (Convex's
  `BTreeMap<ComponentPath, _>`, in path order) to its tables. A namespace without tables is absent, so a deployment
  with none answers `{}`, where bunvex wrote `{"": []}`.
- **Data sync.**
  - Targets come from every namespace (`ResolvedStreamingExportSelection`), a hidden table left out as before.
  - Each value carries `component`. Truncates are `{component, table}`, each page's in (path, table) order.
  - The cursor's tablet references and the progress row's `currentComponent` carry the path.
- **The ZIP export's namespace order** (PR 1) is now `ComponentId` order too, where PR 1 compared the encoded ids.

Tests:

- `streaming-export.test.ts`, "components (STUDY-204)":
  - `list_snapshot` over the three components gives every table with its `_component`.
  - `component=counter` gives only `counter`'s tables, `tableName=messages&component=counter/inner` only that table,
    and `component=""` only the root's.
  - A change in `second` after the snapshot comes in `document_deltas` with `_component: "second"`, and is left out
    of a `counter` selection.
  - `json_schemas?byComponent=true` has the four paths, and its flat form has every table.
  - `get_table_column_names` lists the four paths in order.
- `data-sync.test.ts`: a cold start truncates and walks every component's tables, each value with its path. A later
  change in `counter/inner` carries it, and a selection of `second` streams only `second`.
- `component-fixture.ts`: the shared components of the export, import and streaming tests.

Sabotage, each making a test fail:

| Sabotage | Tests that fail |
|---|---|
| Tables kept to the root's | the streaming and data-sync tests |
| `_component` written `""` | the streaming test |
| A data-sync value's `component` written `""` | the data-sync test |

## 4. Divergences

None new. DV-215 narrowed with PR 1 and PR 2b and is resolved by PR 3.

## 6. Open questions

- **Q1.** A component's documents in an import are checked against its schema with its `v.id`s named by its catalog
  as it is, not as the import will leave it (§3, PR 2b). Matching Convex's per-namespace `ImportSchemaConstraints`
  needs the as-will-be names for each namespace in the write path's schema check. It only matters when a component's
  schema points at a table the same import renumbers.

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
