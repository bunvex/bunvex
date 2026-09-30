// The Database screen's one side panel (UI-01 §12.3): a document, the table's schema, or its indexes —
// never two at once. Which one is open lives in the URL (`doc`, `panel`); Escape or the close button closes
// it. Below 1 536 px (2xl) it is a drawer over the table instead of taking width from it.
import { Badge } from "@bunvex/ui/components/badge";
import { Button } from "@bunvex/ui/components/button";
import { CopyButton } from "@bunvex/ui/components/copy-button";
import { JsonView } from "@bunvex/ui/components/json-view";
import type { ColumnState } from "@bunvex/ui/lib/column-state";
import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import { type ReactNode, useEffect, useId } from "react";
import { useQueryScope } from "../context.tsx";
import { documentQuery, schemaQuery } from "../data/queries.ts";
import { type TableInfo, toDataSourceError } from "../data-source.ts";
import { formatCount } from "../screens/stats.ts";
import { ErrorState } from "../shell/error-state.tsx";
import { AddDocuments } from "./add-documents.tsx";
import { ColumnSettings } from "./column-settings.tsx";
import { formatTime } from "./values.ts";

export type PanelState =
  | { kind: "document"; id: string }
  | { kind: "schema" }
  | { kind: "indexes" }
  | { kind: "add"; onAdded: (ids: string[]) => void }
  | { kind: "columns"; fields: string[]; state: ColumnState; onChange: (s: ColumnState) => void };

function Panel({ title, onClose, children }: { title: ReactNode; onClose: () => void; children: ReactNode }) {
  const titleId = useId();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <aside
      aria-labelledby={titleId}
      className="fixed inset-y-0 right-0 z-30 flex w-full flex-col overflow-hidden border-l bg-background shadow-xl sm:w-[28rem] 2xl:static 2xl:z-auto 2xl:w-[26rem] 2xl:shrink-0 2xl:shadow-none"
    >
      <header className="flex h-11 items-center gap-2 border-b px-4">
        <h2 id={titleId} className="min-w-0 flex-1 truncate font-medium">
          {title}
        </h2>
        <Button variant="ghost" size="icon-sm" aria-label="Close the panel" onClick={onClose}>
          <X aria-hidden="true" />
        </Button>
      </header>
      <div className="flex-1 overflow-y-auto p-4">{children}</div>
    </aside>
  );
}

export function SidePanel({ state, info, onClose }: { state: PanelState; info: TableInfo; onClose: () => void }) {
  if (state.kind === "document") return <DocumentPanel table={info.name} id={state.id} onClose={onClose} />;
  if (state.kind === "schema") return <SchemaPanel info={info} onClose={onClose} />;
  if (state.kind === "columns")
    return (
      <Panel title={`Columns of ${info.name}`} onClose={onClose}>
        <ColumnSettings fields={state.fields} state={state.state} onChange={state.onChange} />
      </Panel>
    );
  if (state.kind === "add")
    return (
      <Panel title={`Add documents to ${info.name}`} onClose={onClose}>
        <AddDocuments table={info.name} onAdded={state.onAdded} />
      </Panel>
    );
  return <IndexesPanel info={info} onClose={onClose} />;
}

function DocumentPanel({ table, id, onClose }: { table: string; id: string; onClose: () => void }) {
  const { data: doc, error, isPending, refetch } = useQuery(documentQuery(useQueryScope(), table, id));
  return (
    <Panel title={<span className="font-mono text-sm">{id}</span>} onClose={onClose}>
      {isPending ? (
        <p className="text-sm text-muted-foreground">Loading the document…</p>
      ) : error ? (
        <ErrorState error={toDataSourceError(error)} onRetry={() => void refetch()} />
      ) : doc === null || doc === undefined ? (
        <p className="text-sm text-muted-foreground">No document with this id in {table}. It may have been deleted.</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-muted-foreground">
              Created <time dateTime={new Date(doc._creationTime).toISOString()}>{formatTime(doc._creationTime)}</time>
            </p>
            <CopyButton text={JSON.stringify(doc, null, 2)} label="Copy JSON" />
          </div>
          <JsonView className="mt-3" value={doc} label={`Document ${id}`} />
        </>
      )}
    </Panel>
  );
}

function SchemaPanel({ info, onClose }: { info: TableInfo; onClose: () => void }) {
  const { data: schema } = useQuery(schemaQuery(useQueryScope()));
  const declared = schema?.tables.find((t) => t.name === info.name);
  return (
    <Panel title={`Schema of ${info.name}`} onClose={onClose}>
      {!schema ? (
        <p className="text-sm text-muted-foreground">Loading the schema…</p>
      ) : !declared ? (
        <p className="text-sm">
          <strong className="font-medium">{info.name}</strong> is not in the schema: its documents were written without
          a declaration. Declare it to give it indexes and, once validation exists, a document type.
        </p>
      ) : declared.validator === undefined ? (
        <p className="text-sm">
          {info.name} is declared, without a document type: any document is accepted.
          {!schema.enforced && " Documents are not validated on this deployment."}
        </p>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            {schema.enforced ? "Documents are validated against this type." : "Declared, but not enforced."}
          </p>
          <JsonView className="mt-3" value={declared.validator} label={`Document type of ${info.name}`} />
        </>
      )}
    </Panel>
  );
}

function IndexesPanel({ info, onClose }: { info: TableInfo; onClose: () => void }) {
  return (
    <Panel title={`Indexes of ${info.name}`} onClose={onClose}>
      <ul className="divide-y border">
        {info.indexes.map((ix) => (
          <li key={ix.name} className="flex flex-col gap-1 p-3 text-sm">
            <div className="flex items-center gap-2">
              <span className="font-mono font-medium">{ix.name}</span>
              {ix.system && <Badge variant="secondary">system</Badge>}
              {ix.state === "backfilling" ? (
                <Badge variant="outline" className="border-warning text-warning">
                  backfilling
                </Badge>
              ) : null}
            </div>
            <span className="font-mono text-xs text-muted-foreground">
              {ix.fields.join(", ")}
              {ix.name !== "by_id" && ", _id"}
            </span>
            {ix.state === "backfilling" && ix.progress && (
              <span className="text-xs text-muted-foreground tabular-nums">
                {formatCount(ix.progress.indexed)}
                {ix.progress.total !== undefined && ` of ${formatCount(ix.progress.total)}`} documents indexed. It can
                be queried once every document is in it.
              </span>
            )}
          </li>
        ))}
      </ul>
    </Panel>
  );
}
