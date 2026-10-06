// The system tables on the Database screen (STUDY-131 AD-24, a bunvex addition): a "Show system tables"
// switch in the tables column, for a credential that may view data and a source that offers them, and one
// system table's documents, read-only — every field as stored, no editing, no filters, oldest or newest first.
// Whether the switch is on is this browser's preference; the open table lives in the URL like any table's.
import { Button } from "@bunvex/ui/components/button";
import { DataTable, type DataTableColumn, dataTableColumns } from "@bunvex/ui/components/data-table";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { useQueryScope } from "../context.tsx";
import { capabilitiesQuery, systemDocumentsQuery, systemTablesQuery } from "../data/queries.ts";
import { type Document, toDataSourceError } from "../data-source.ts";
import { formatCount } from "../screens/stats.ts";
import { ErrorState } from "../shell/error-state.tsx";
import { cellText, documentFields } from "./values.ts";

const SHOW_KEY = "bunvex-dashboard:show-system-tables";

/** Whether this credential and source can show the system tables at all. */
export function useCanViewSystemTables(): boolean {
  const scope = useQueryScope();
  const { data: caps } = useQuery(capabilitiesQuery(scope));
  return (
    typeof scope.source.listSystemTables === "function" &&
    typeof scope.source.listSystemDocuments === "function" &&
    caps !== undefined &&
    caps.operations.includes("viewData")
  );
}

/** The switch's state, kept in this browser (storage may be blocked: then for the page only). */
export function useShowSystemTables(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(() => {
    try {
      return localStorage.getItem(SHOW_KEY) === "1";
    } catch {
      return false;
    }
  });
  const set = useCallback((next: boolean) => {
    setOn(next);
    try {
      if (next) localStorage.setItem(SHOW_KEY, "1");
      else localStorage.removeItem(SHOW_KEY);
    } catch {}
  }, []);
  return [on, set];
}

/** The system tables, for the tables column (empty until loaded, or when not offered). */
export function useSystemTables(enabled: boolean) {
  const scope = useQueryScope();
  const q = useQuery({
    ...systemTablesQuery(scope),
    enabled: enabled && typeof scope.source.listSystemTables === "function",
  });
  return q.data ?? [];
}

const col = dataTableColumns<Document>();
const columnsFor = (fields: string[]): DataTableColumn<Document>[] =>
  fields.map((field) =>
    col.accessor((d) => d[field], {
      id: field,
      header: field,
      cell: (c) => {
        const t = cellText(field, c.getValue());
        return (
          <span className="block truncate font-mono text-xs" title={t.text}>
            {t.text}
          </span>
        );
      },
    }),
  );

export function SystemTableView({ table }: { table: string }) {
  const scope = useQueryScope();
  const allowed = useCanViewSystemTables();
  const [order, setOrder] = useState<"asc" | "desc">("asc");
  const { data: tables } = useQuery({ ...systemTablesQuery(scope), enabled: allowed });
  const info = tables?.find((t) => t.name === table);
  const query = useInfiniteQuery({ ...systemDocumentsQuery(scope, table, order), enabled: allowed });
  const docs = useMemo(() => query.data?.pages.flatMap((p) => p.page) ?? [], [query.data]);
  const fields = documentFields(docs);
  const fieldsKey = fields.join("\u0000");
  // biome-ignore lint/correctness/useExhaustiveDependencies: columns change only when the set of fields does
  const columns = useMemo(() => columnsFor(fields), [fieldsKey]);
  if (!allowed)
    return (
      <div className="p-4 md:p-6">
        <h1 className="font-mono text-xl font-semibold tracking-tight">{table}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          System tables are shown only to a credential that may view data.
        </p>
      </div>
    );
  const error = query.isError ? toDataSourceError(query.error) : undefined;
  return (
    <div className="flex h-[calc(100svh-3rem)] min-w-0 flex-1 flex-col lg:h-auto lg:min-h-0">
      <div className="flex min-h-11 flex-wrap items-center gap-x-2 gap-y-1 border-b px-4 py-1 md:px-6">
        <h1 className="font-mono text-base font-semibold tracking-tight">{table}</h1>
        <span aria-hidden="true" className="text-muted-foreground">
          ·
        </span>
        <span className="text-sm text-muted-foreground">
          {info?.appVisible ? "System table, readable by apps through db.system" : "Private system table"}
        </span>
        {info?.documentCount != null && (
          <>
            <span aria-hidden="true" className="text-muted-foreground">
              ·
            </span>
            <span className="text-sm text-muted-foreground tabular-nums">
              {formatCount(info.documentCount)} document{info.documentCount === 1 ? "" : "s"}
            </span>
          </>
        )}
        <span className="text-sm text-muted-foreground" title="System tables are never edited from the dashboard">
          Read-only
        </span>
        <span className="ml-auto">
          <Button variant="ghost" size="sm" onClick={() => setOrder((o) => (o === "asc" ? "desc" : "asc"))}>
            {order === "asc" ? "Oldest first" : "Newest first"}
          </Button>
        </span>
      </div>
      {info?.description && (
        <p className="border-b px-4 py-1.5 text-sm text-muted-foreground md:px-6">{info.description}</p>
      )}
      {error && docs.length === 0 ? (
        <div className="p-4 md:px-6">
          <ErrorState error={error} onRetry={() => void query.refetch()} />
        </div>
      ) : (
        <DataTable
          label={`Documents in ${table}`}
          fill
          columns={columns}
          data={docs}
          getRowId={(d) => d._id}
          resetKey={`${table}\u0000${order}`}
          defaultColumnWidth={(id) => (id === "_id" ? 260 : 180)}
          onEndReached={() => {
            if (query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage();
          }}
          empty={query.isPending ? "Loading…" : `No documents in ${table}.`}
          footer={
            <span aria-live="polite">
              {query.isFetchingNextPage ? "Loading more…" : `${formatCount(docs.length)} documents loaded`}
            </span>
          }
        />
      )}
    </div>
  );
}
