// The Database screen (UI-01 §12.3): the tables beside, and one table's documents — filtered through its
// indexes and fields, live while it is open, with one side panel for a document, the schema or the
// indexes. Everything that says what is shown lives in the URL: the table, the filter, the open panel.
import { Button } from "@bunvex/ui/components/button";
import { preloadCodeEditor } from "@bunvex/ui/components/code-editor";
import { DataTable, type DataTableColumn, dataTableColumns } from "@bunvex/ui/components/data-table";
import { cn } from "@bunvex/ui/lib/utils";
import { keepPreviousData, useInfiniteQuery, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryScope } from "../context.tsx";
import { capabilitiesQuery, dashboardKeys, documentsQuery, referenceQuery, tablesQuery } from "../data/queries.ts";
import { type Document, type FilterExpression, type TableInfo, toDataSourceError } from "../data-source.ts";
import { DashLink, type TableSearch, tableRoute } from "../router.tsx";
import { formatCount } from "../screens/stats.ts";
import { ErrorState } from "../shell/error-state.tsx";
import { DeleteDialog, DeleteSelected, deleteDocumentsNow, type Outcome, TableMenu } from "./actions.tsx";
import { CellEditor } from "./cell-editor.tsx";
import { type CellActions, CellMenuItems, cellShortcut, withClause } from "./cell-menu.tsx";
import { useColumnState } from "./column-settings.tsx";
import { useCanCreateTable } from "./create-table.tsx";
import { FilterBar } from "./filter-bar.tsx";
import { activeCount } from "./filter-model.ts";
import { decodeFilter, encodeFilter } from "./filter-url.ts";
import { useLiveTable } from "./live.ts";
import { type PanelState, SidePanel } from "./side-panel.tsx";
import { TablesSidebar } from "./tables-sidebar.tsx";
import { ValueView, type Viewing } from "./value-view.tsx";
import { cellText, documentFields } from "./values.ts";

/**
 * Whether "Delete document" in a cell's menu asks first (STUDY-12 D13, the owner's call on 30 Sep 2026).
 * Convex deletes at once and asks only on a production deployment (`isProtectedDeployment` in its
 * `TableContextMenu.tsx`). bunvex has no deployment kinds yet, so every deployment is treated as one that
 * may be production and asks. When deployments get a kind (production / development), replace this
 * constant with a check of it — true for production — to match Convex.
 */
const CONFIRM_DELETE_FROM_CELL_MENU = true;

export function DatabaseScreen(): ReactNode {
  const { table } = tableRoute.useParams();
  const scope = useQueryScope();
  const { data: tables } = useSuspenseQuery(tablesQuery(scope));
  const info = tables.find((t) => t.name === table);
  const canCreate = useCanCreateTable() === true;
  return (
    // full-bleed inside <main>: the sidebar and the panel run to its edges
    // the grid runs to the bottom of the viewport from lg (the sidebar beside it); stacked below that
    <div className="-m-4 flex min-h-[calc(100svh-3rem)] flex-col md:-m-6 lg:h-[calc(100svh-3rem)] lg:flex-row">
      <TablesSidebar tables={tables} current={table} canCreate={canCreate} />
      {info ? (
        <TableView key={info.name} info={info} />
      ) : (
        <div className="p-4 md:p-6">
          <h1 className="text-xl font-semibold tracking-tight">{table}</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            There is no table named “{table}”. It may have been deleted or renamed.
          </p>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ one table

const col = dataTableColumns<Document>();

function Cell({ field, value }: { field: string; value: Document[string] | undefined }) {
  const c = cellText(field, value);
  return (
    <span
      title={c.kind === "json" || c.kind === "string" || c.kind === "bytes" || c.kind === "int64" ? c.text : undefined}
      // a block that truncates with an ellipsis; numbers right-aligned so magnitudes line up (UX-21)
      className={cn(
        "block truncate",
        (c.kind === "number" || c.kind === "int64") && "text-right",
        (c.kind === "id" || c.kind === "json" || c.kind === "boolean" || c.kind === "int64" || c.kind === "bytes") &&
          "font-mono text-xs",
        (c.kind === "null" || c.kind === "json") && "text-muted-foreground",
        c.kind === "missing" && "text-muted-foreground italic",
        (c.kind === "number" || c.kind === "int64" || c.kind === "time") && "tabular-nums",
      )}
    >
      {c.text}
    </span>
  );
}

function columnsFor(table: string, fields: string[]): DataTableColumn<Document>[] {
  return fields.map((field) =>
    field === "_id"
      ? col.accessor((d) => d._id, {
          id: "_id",
          header: "_id",
          cell: (c) => (
            <DashLink
              link={{
                to: "/database/$table",
                params: { table },
                search: (s: TableSearch) => ({ ...s, doc: c.getValue(), panel: undefined }),
              }}
              className="font-mono text-xs font-medium underline-offset-4 outline-none hover:underline"
              // in the grid, the cell holds the focus; Enter on it opens the document too
              tabIndex={-1}
              onClick={(e) => e.stopPropagation()}
            >
              {c.getValue()}
            </DashLink>
          ),
        })
      : col.accessor((d) => d[field], {
          id: field,
          header: field,
          cell: (c) => <Cell field={field} value={c.getValue()} />,
        }),
  );
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
const describeChanges = ({ changed, added }: { changed: number; added: number }) =>
  [changed > 0 && `${plural(changed, "document")} changed`, added > 0 && `${plural(added, "document")} added`]
    .filter(Boolean)
    .join(", ");

function TableView({ info }: { info: TableInfo }) {
  const table = info.name;
  const scope = useQueryScope();
  const search = tableRoute.useSearch();
  const navigate = tableRoute.useNavigate();
  const applied = decodeFilter(search.filter);
  const expr: FilterExpression | undefined = applied ?? undefined;
  const liveError = useLiveTable(table);
  const { data: caps } = useQuery(capabilitiesQuery(scope));
  const canWrite = caps !== undefined && !caps.readOnly && caps.operations.includes("writeData");
  const { source } = scope;
  // each write needs the grant and the source's method for it
  const can = {
    edit: canWrite && typeof source.patchDocuments === "function",
    insert: canWrite && typeof source.insertDocuments === "function",
    delete: canWrite && typeof source.deleteDocuments === "function",
    clear: canWrite && typeof source.clearTable === "function",
    replace: canWrite && typeof source.replaceDocument === "function",
  };
  const writable = can.edit;
  const queryClient = useQueryClient();

  const query = useInfiniteQuery({ ...documentsQuery(scope, table, expr), placeholderData: keepPreviousData });
  // `data` of the previous filter stays shown while the new one loads (placeholder), or after it failed
  const docs = useMemo(() => query.data?.pages.flatMap((p) => p.page) ?? [], [query.data]);
  const fields = documentFields(docs);
  const fieldsKey = fields.join("\u0000");
  // biome-ignore lint/correctness/useExhaustiveDependencies: columns change only when the set of fields does
  const columns = useMemo(() => columnsFor(table, fields), [table, fieldsKey]);
  const rejected = query.isError ? toDataSourceError(query.error) : undefined;

  // selection: cleared by a new filter; documents that left the list (deleted) leave it too
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [focusRequest, setFocusRequest] = useState(0);
  const [columnState, setColumnState] = useColumnState(scope.scope, table);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new filter is a new list
  useEffect(() => setSelected(new Set()), [search.filter]);
  useEffect(preloadCodeEditor, []); // the filter, cell and document editors all use it
  const selectedIds = useMemo(() => docs.filter((d) => selected.has(d._id)).map((d) => d._id), [docs, selected]);

  // what the last action did, said once (and to screen readers)
  const [notice, setNotice] = useState<Outcome | null>(null);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(t);
  }, [notice]);
  const afterWrite = useCallback(
    (o: Outcome) => {
      setNotice(o);
      // sources without live updates show the result too
      const all = dashboardKeys.all(scope.scope);
      void queryClient.invalidateQueries({ queryKey: [...all, "documents", table] });
      void queryClient.invalidateQueries({ queryKey: dashboardKeys.tables(scope.scope) });
    },
    [queryClient, scope.scope, table],
  );

  const setSearch = useCallback(
    (patch: Partial<TableSearch>) =>
      navigate({ search: (s: TableSearch): TableSearch => ({ ...s, ...patch }), replace: true }),
    [navigate],
  );
  const closePanel = useCallback(() => setSearch({ doc: undefined, panel: undefined }), [setSearch]);
  const [editRequest, setEditRequest] = useState<number>();
  // what a cell's context menu and shortcuts do (cell-menu.tsx)
  const [viewing, setViewing] = useState<Viewing | null>(null);
  const [deleting, setDeleting] = useState<Document | null>(null);
  const goToReference = async (id: string) => {
    const target = await queryClient.fetchQuery(referenceQuery(scope, id)).catch(() => null);
    if (target) void navigate({ to: "/database/$table", params: { table: target }, search: { doc: id } });
    else setNotice({ ok: false, message: `No document has the id ${id}.` });
  };
  const cellActions = (d: Document, field: string, anchor: () => DOMRect | undefined): CellActions => ({
    viewValue: () => setViewing({ field, value: d[field], anchor: anchor() ?? new DOMRect() }),
    goToReference: scope.source.tableOfId ? (id) => void goToReference(id) : undefined,
    deleteDocument: can.delete
      ? () =>
          CONFIRM_DELETE_FROM_CELL_MENU
            ? setDeleting(d)
            : void deleteDocumentsNow(scope.source, table, [d._id]).then(afterWrite)
      : undefined,
    filter: (clause) => setSearch({ filter: encodeFilter(withClause(applied, clause)) }),
    copy: (text, what) =>
      void navigator.clipboard.writeText(text).then(
        () => setNotice({ ok: true, message: `Copied ${what === "document" ? "the document" : what}.` }),
        () => setNotice({ ok: false, message: "Could not copy to the clipboard." }),
      ),
    viewDocument: () => setSearch({ doc: d._id, panel: undefined }),
    editDocument: can.replace
      ? () => {
          setEditRequest((n) => (n ?? 0) + 1);
          setSearch({ doc: d._id, panel: undefined });
        }
      : undefined,
  });
  /** Whether the open document's editor holds unsaved changes (then the panel does not follow the row). */
  const documentDirty = useRef(false);
  /** The open document follows the current row: a click on any of its cells, or ↑/↓ onto it. */
  const follow = (d: Document) => {
    if (!search.doc || d._id === search.doc) return;
    if (documentDirty.current) {
      setNotice({ ok: false, message: "Save or cancel your edit to open another document." });
      return;
    }
    setSearch({ doc: d._id, panel: undefined });
  };
  const panel: PanelState | null = search.doc
    ? {
        kind: "document",
        id: search.doc,
        canEdit: can.replace,
        editRequest,
        onDirtyChange: (dirty) => {
          documentDirty.current = dirty;
        },
      }
    : search.panel === "add"
      ? can.insert
        ? {
            kind: "add",
            onAdded: (ids) => {
              closePanel();
              afterWrite({
                ok: true,
                message: `Added ${formatCount(ids.length)} document${ids.length === 1 ? "" : "s"} to ${table}.`,
              });
            },
          }
        : null
      : search.panel === "columns"
        ? { kind: "columns", fields, state: columnState, onChange: setColumnState }
        : search.panel
          ? { kind: search.panel }
          : null;

  const filtered = expr !== undefined && (activeCount(expr) > 0 || expr.order !== "desc" || expr.index !== undefined);
  const loaded = docs.length;
  const status = query.isFetchingNextPage
    ? "Loading more…"
    : filtered
      ? `${formatCount(loaded)} matching document${loaded === 1 ? "" : "s"}${query.hasNextPage ? " loaded" : ""}`
      : `${formatCount(loaded)}${info.documentCount === undefined ? "" : ` of ${formatCount(info.documentCount)}`} documents loaded`;

  return (
    // full-bleed (UI-01 §22.3): two bars across the top — the table and its actions, the filters — and the
    // grid filling the rest, edge to edge between the tables list and the docked panel, down to the bottom
    // below lg the table list sits above: the table takes a screen's height of its own (its grid scrolls inside)
    <div className="flex h-[calc(100svh-3rem)] min-w-0 shrink-0 lg:h-auto lg:min-h-0 lg:flex-1">
      <div className="@container/table flex min-h-0 min-w-0 flex-1 flex-col">
        {/* Bar 1: as tall as the side panel's header (44 px), so their bottom lines continue across */}
        <div className="flex min-h-11 flex-wrap items-center gap-x-2 gap-y-1 border-b px-4 py-1 md:px-6">
          <h1 className="font-mono text-base font-semibold tracking-tight">{table}</h1>
          {info.documentCount !== undefined && (
            <>
              <span aria-hidden="true" className="text-muted-foreground">
                ·
              </span>
              <span className="text-sm text-muted-foreground tabular-nums">
                {formatCount(info.documentCount)} document{info.documentCount === 1 ? "" : "s"}
              </span>
            </>
          )}
          {!info.declared && (
            <>
              <span aria-hidden="true" className="text-muted-foreground">
                ·
              </span>
              <span className="text-sm text-muted-foreground">Not in the schema</span>
            </>
          )}
          {caps && !writable && (
            <span className="text-sm text-muted-foreground" title="This credential cannot change data">
              Read-only
            </span>
          )}
          <span className="ml-auto flex flex-wrap items-center gap-1">
            {can.delete && selectedIds.length > 0 && (
              <DeleteSelected
                table={table}
                ids={selectedIds}
                onDone={(o) => {
                  if (o.ok) setSelected(new Set());
                  afterWrite(o);
                }}
                onClosed={() => setFocusRequest((n) => n + 1)}
              />
            )}
            {can.insert && (
              <Button
                variant="outline"
                size="sm"
                aria-pressed={search.panel === "add" && !search.doc}
                onClick={() => setSearch({ doc: undefined, panel: search.panel === "add" ? undefined : "add" })}
              >
                <Plus aria-hidden="true" />
                {/* a narrow bar (beside a docked panel) keeps the icon; the name stays for assistive tech */}
                <span className="sr-only @lg/table:not-sr-only">Add documents</span>
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="hidden @2xl/table:inline-flex"
              aria-pressed={search.panel === "schema" && !search.doc}
              onClick={() => setSearch({ doc: undefined, panel: search.panel === "schema" ? undefined : "schema" })}
            >
              Schema
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="hidden @2xl/table:inline-flex"
              aria-pressed={search.panel === "indexes" && !search.doc}
              onClick={() => setSearch({ doc: undefined, panel: search.panel === "indexes" ? undefined : "indexes" })}
            >
              Indexes
            </Button>
            {typeof scope.source.tableRate === "function" && (
              <Button
                variant="ghost"
                size="sm"
                className="hidden @2xl/table:inline-flex"
                aria-pressed={search.panel === "metrics" && !search.doc}
                onClick={() => setSearch({ doc: undefined, panel: search.panel === "metrics" ? undefined : "metrics" })}
              >
                Metrics
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="hidden @2xl/table:inline-flex"
              aria-pressed={search.panel === "columns" && !search.doc}
              onClick={() => setSearch({ doc: undefined, panel: search.panel === "columns" ? undefined : "columns" })}
            >
              Columns
            </Button>
            <TableMenu
              table={table}
              count={info.documentCount}
              canClear={can.clear}
              onDone={afterWrite}
              panels={(
                [
                  "schema",
                  "indexes",
                  ...(typeof scope.source.tableRate === "function" ? (["metrics"] as const) : []),
                  "columns",
                ] as const
              ).map((panel) => ({
                label: panel[0]!.toUpperCase() + panel.slice(1),
                open: () => setSearch({ doc: undefined, panel }),
              }))}
            />
          </span>
        </div>
        <FilterBar
          info={info}
          fields={fields}
          applied={applied}
          appliedParam={search.filter}
          rejected={rejected}
          onApply={(_, param) => setSearch({ filter: param })}
        />
        {notice && (
          <p
            role={notice.ok ? "status" : "alert"}
            className={cn(
              "border-b px-4 py-1.5 text-sm md:px-6",
              notice.ok ? "text-muted-foreground" : "text-destructive",
            )}
          >
            {notice.message}
          </p>
        )}
        {search.filter && !applied && (
          <p className="border-b px-4 py-1.5 text-sm text-muted-foreground md:px-6">
            The filter in this link could not be read; showing every document.
          </p>
        )}
        {liveError && (
          <div className="border-b px-4 py-2 md:px-6">
            <ErrorState error={liveError} />
          </div>
        )}
        {rejected && rejected.code !== "invalid_request" && docs.length === 0 ? (
          <div className="p-4 md:px-6">
            <ErrorState error={rejected} onRetry={() => void query.refetch()} />
          </div>
        ) : (
          <DataTable
            label={`Documents in ${table}`}
            fill
            className={cn(query.isPlaceholderData && "opacity-60")}
            columns={columns}
            data={docs}
            getRowId={(d) => d._id}
            resetKey={search.filter ?? ""}
            // live: what another tab, a function or this editor just changed flashes for a moment
            highlightChanges={{ announce: describeChanges }}
            focusRequest={focusRequest}
            columnState={columnState}
            // an _id is 32 characters of mono: wide enough to read whole
            defaultColumnWidth={(id) => (id === "_id" ? 260 : 180)}
            onColumnStateChange={setColumnState}
            selection={can.delete ? { selected, onChange: setSelected, describe: (d) => d._id } : undefined}
            onEndReached={() => {
              if (query.hasNextPage && !query.isFetchingNextPage && !query.isPlaceholderData)
                void query.fetchNextPage();
            }}
            grid={{
              // system fields are the engine's; every other field is edited in place
              canEdit: (_, field) => writable && !field.startsWith("_"),
              onCellActivate: (d) => setSearch({ doc: d._id, panel: undefined }),
              // the open document follows the current row — a click on any cell, or ↑/↓ — unless its editor
              // holds unsaved changes (UI-01 §22.3)
              onCellFocus: follow,
              onCellClick: follow,
              renderEditor: ({ row, columnId, done }) => (
                <CellEditor table={table} doc={row} field={columnId} done={done} />
              ),
              cellMenu: ({ row, columnId, edit, anchor }) => (
                <CellMenuItems
                  doc={row}
                  field={columnId}
                  canEdit={writable && !columnId.startsWith("_")}
                  edit={edit}
                  actions={cellActions(row, columnId, anchor)}
                />
              ),
              onCellKey: (e, { row, columnId, anchor }) =>
                cellShortcut(e, row, columnId, cellActions(row, columnId, anchor)),
            }}
            empty={
              query.isPending
                ? "Loading…"
                : filtered
                  ? "No document matches these filters."
                  : `No documents in ${table} yet.`
            }
            footer={<span aria-live="polite">{status}</span>}
          />
        )}
      </div>
      {panel && <SidePanel state={panel} info={info} onClose={closePanel} />}
      {viewing && (
        <ValueView
          viewing={viewing}
          onClose={() => {
            setViewing(null);
            setFocusRequest((n) => n + 1);
          }}
        />
      )}
      {deleting && (
        <DeleteDialog
          table={table}
          ids={[deleting._id]}
          open
          onOpenChange={(open) => {
            if (open) return;
            setDeleting(null);
            setFocusRequest((n) => n + 1);
          }}
          onDone={afterWrite}
        />
      )}
    </div>
  );
}
