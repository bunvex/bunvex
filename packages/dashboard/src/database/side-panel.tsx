// The Database screen's one side panel (UI-01 §12.3): a document, the table's schema, or its indexes —
// never two at once. Which one is open lives in the URL (`doc`, `panel`); Escape or the close button closes
// it. Below 1 536 px (2xl) it is a drawer over the table instead of taking width from it.
import { Badge } from "@bunvex/ui/components/badge";
import { Button } from "@bunvex/ui/components/button";
import { CopyButton } from "@bunvex/ui/components/copy-button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@bunvex/ui/components/tabs";
import type { ColumnState } from "@bunvex/ui/lib/column-state";
import { cn } from "@bunvex/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { useQueryScope } from "../context.tsx";
import { documentQuery, inferredTypeQuery, schemaQuery, tablesQuery } from "../data/queries.ts";
import { type TableInfo, toDataSourceError } from "../data-source.ts";
import { TableMetrics } from "../metrics/table-metrics.tsx";
import { formatCount } from "../screens/stats.ts";
import { ErrorState } from "../shell/error-state.tsx";
import { Panel } from "../shell/panel.tsx";
import { AddDocuments } from "./add-documents.tsx";
import { ColumnSettings } from "./column-settings.tsx";
import { DocumentEditor } from "./document-editor.tsx";
import { formatLiteral } from "./literal.ts";
import { LiteralView } from "./literal-view.tsx";
import { generatedSchemaCode, type SchemaCode, schemaCode } from "./schema-code.ts";
import { formatTime } from "./values.ts";

export type PanelState =
  /** `editRequest` changes each time the document should open in its editor (Shift+Enter on a cell). */
  | { kind: "document"; id: string; canEdit: boolean; editRequest?: number }
  | { kind: "schema" }
  | { kind: "indexes" }
  | { kind: "metrics" }
  | { kind: "add"; onAdded: (ids: string[]) => void }
  | { kind: "columns"; fields: string[]; state: ColumnState; onChange: (s: ColumnState) => void };

export function SidePanel({ state, info, onClose }: { state: PanelState; info: TableInfo; onClose: () => void }) {
  if (state.kind === "document")
    return (
      <DocumentPanel
        key={state.id} // another document starts in its own view, not in the last one's editor
        table={info.name}
        id={state.id}
        canEdit={state.canEdit}
        editRequest={state.editRequest}
        onClose={onClose}
      />
    );
  if (state.kind === "schema") return <SchemaPanel info={info} onClose={onClose} />;
  if (state.kind === "columns")
    return (
      <Panel kind="database-columns" title={`Columns of ${info.name}`} onClose={onClose}>
        <ColumnSettings fields={state.fields} state={state.state} onChange={state.onChange} />
      </Panel>
    );
  if (state.kind === "add")
    return (
      <Panel kind="database-add" title={`Add documents to ${info.name}`} onClose={onClose}>
        <AddDocuments table={info.name} onAdded={state.onAdded} />
      </Panel>
    );
  if (state.kind === "metrics")
    return (
      <Panel kind="database-metrics" title={`Metrics of ${info.name}`} onClose={onClose}>
        <TableMetrics table={info.name} />
      </Panel>
    );
  return <IndexesPanel info={info} onClose={onClose} />;
}

function DocumentPanel(props: {
  table: string;
  id: string;
  canEdit: boolean;
  editRequest?: number;
  onClose: () => void;
}) {
  const { table, id, onClose } = props;
  const { data: doc, error, isPending, refetch } = useQuery(documentQuery(useQueryScope(), table, id));
  const [editing, setEditing] = useState(props.canEdit && props.editRequest !== undefined);
  const firstRequest = useRef(props.editRequest);
  useEffect(() => {
    if (props.canEdit && props.editRequest !== firstRequest.current) setEditing(true);
  }, [props.canEdit, props.editRequest]);
  const [saved, setSaved] = useState(false);
  return (
    <Panel kind="database-document" title={<span className="font-mono text-sm">{id}</span>} onClose={onClose}>
      {isPending ? (
        <p className="text-sm text-muted-foreground">Loading the document…</p>
      ) : error ? (
        <ErrorState error={toDataSourceError(error)} onRetry={() => void refetch()} />
      ) : doc === null || doc === undefined ? (
        <p className="text-sm text-muted-foreground">No document with this id in {table}. It may have been deleted.</p>
      ) : editing ? (
        <DocumentEditor
          table={table}
          doc={doc}
          onDone={(ok) => {
            setEditing(false);
            setSaved(ok);
          }}
        />
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-muted-foreground">
              Created <time dateTime={new Date(doc._creationTime).toISOString()}>{formatTime(doc._creationTime)}</time>
            </p>
            <span className="flex gap-2">
              {props.canEdit && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setSaved(false);
                    setEditing(true);
                  }}
                >
                  Edit
                </Button>
              )}
              <CopyButton text={formatLiteral(doc, "  ")} label="Copy" />
            </span>
          </div>
          {saved && (
            <p role="status" className="mt-2 text-sm text-muted-foreground">
              Saved.
            </p>
          )}
          <LiteralView className="mt-3" value={doc} label={`Document ${id}`} />
        </>
      )}
    </Panel>
  );
}

function SchemaPanel({ info, onClose }: { info: TableInfo; onClose: () => void }) {
  const scope = useQueryScope();
  const { data: schema } = useQuery(schemaQuery(scope));
  const { data: tables = [] } = useQuery(tablesQuery(scope));
  const declared = schema?.tables.find((t) => t.name === info.name);
  const saved = schema ? schemaCode(schema, tables) : null;
  const canGenerate = typeof scope.source.inferDocumentType === "function";
  // as Convex: the saved schema first, or the generated one when nothing is saved
  const [tab, setTab] = useState<"saved" | "generated">();
  const shown = tab ?? (saved || !canGenerate ? "saved" : "generated");
  const savedView = !schema ? (
    <p className="text-sm text-muted-foreground">Loading the schema…</p>
  ) : (
    <>
      <p className="text-sm">
        {!declared ? (
          <>
            <strong className="font-medium">{info.name}</strong> is not in the schema: its documents were written
            without a declaration.
          </>
        ) : declared.validator === undefined ? (
          <>{info.name} is declared without a document type: any document is accepted.</>
        ) : schema.enforced ? (
          <>Documents in {info.name} are validated against its declared type.</>
        ) : (
          <>{info.name} has a declared type, but documents are not validated against it.</>
        )}
      </p>
      {saved ? (
        <SavedSchema code={saved} table={info.name} />
      ) : (
        <p className="mt-3 text-sm text-muted-foreground">
          This deployment has no saved schema yet: declare tables in <code className="font-mono">bunvex/schema.ts</code>
          .
        </p>
      )}
    </>
  );
  return (
    <Panel kind="database-schema" title={`Schema of ${info.name}`} onClose={onClose}>
      {canGenerate ? (
        <Tabs value={shown} onValueChange={(v) => setTab(v as "saved" | "generated")}>
          {/* underlined, as every switch between sibling views (Schedules' tabs) is (UX-7) */}
          <TabsList variant="line">
            <TabsTrigger value="saved" className="text-sm">
              Saved
            </TabsTrigger>
            <TabsTrigger value="generated" className="text-sm">
              Generated
            </TabsTrigger>
          </TabsList>
          <TabsContent value="saved" className="pt-3">
            {savedView}
          </TabsContent>
          <TabsContent value="generated" className="pt-3">
            {shown === "generated" && <GeneratedSchema table={info.name} />}
          </TabsContent>
        </Tabs>
      ) : (
        savedView
      )}
    </Panel>
  );
}

/** A schema for the table generated from its documents (Convex's "Generated" tab), to start a declaration from. */
function GeneratedSchema({ table }: { table: string }) {
  const { data: type, error, isPending } = useQuery(inferredTypeQuery(useQueryScope(), table));
  if (isPending) return <p className="text-sm text-muted-foreground">Looking at the documents…</p>;
  if (error) return <ErrorState error={toDataSourceError(error)} />;
  if (!type) return <p className="text-sm">Add at least one document to {table} to see a suggested schema here.</p>;
  const code = generatedSchemaCode(table, type);
  return (
    <section aria-label="Generated schema">
      <p className="text-sm">
        An approximate schema for {table}, generated from its documents. Paste it into{" "}
        <code className="font-mono">bunvex/schema.ts</code> and adjust the types if they do not fit.
      </p>
      <div className="mt-3 mb-1 flex justify-end">
        <CopyButton text={code} label="Copy the generated schema" />
      </div>
      <pre
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a region that scrolls must be reachable by keyboard
        tabIndex={0}
        // long lines wrap with a hanging indent instead of running past the panel's edge (UX-12)
        className="max-h-[60svh] overflow-auto border bg-muted/40 p-2 pl-6 -indent-4 font-mono text-xs break-words whitespace-pre-wrap"
      >
        {code}
      </pre>
    </section>
  );
}

/** The saved schema as the file that declares it, the table's lines highlighted and scrolled to (as Convex). */
function SavedSchema({ code, table }: { code: SchemaCode; table?: string }) {
  const range = table ? code.lines.get(table) : undefined;
  const first = useRef<HTMLSpanElement>(null);
  const noteId = useId();
  // a block body: scrollIntoView returns a Promise in recent browsers, and an effect may only return a cleanup
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when the table changes
  useEffect(() => {
    first.current?.scrollIntoView?.({ block: "nearest" });
  }, [table]);
  return (
    <section aria-label="Saved schema" className="mt-4">
      <div className="mb-1 flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">Saved schema</h3>
        <CopyButton text={code.code} label="Copy the schema" />
      </div>
      {range && (
        <p id={noteId} className="sr-only">
          Lines {range.from} to {range.to} declare {table}.
        </p>
      )}
      <pre
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a region that scrolls must be reachable by keyboard
        tabIndex={0}
        aria-describedby={range ? noteId : undefined}
        className="max-h-[60svh] overflow-auto border bg-muted/40 py-2 font-mono text-xs"
      >
        {code.code.split("\n").map((line, i) => {
          const n = i + 1;
          const mine = range !== undefined && n >= range.from && n <= range.to;
          return (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: the lines of one text, by position
              key={i}
              ref={mine && n === range.from ? first : undefined}
              data-table-line={mine ? "" : undefined}
              // a long line wraps with a hanging indent, inside the panel (UX-12)
              className={cn(
                "block border-l-2 pr-2 pl-6 -indent-4 break-words whitespace-pre-wrap",
                mine ? "border-info bg-info/10" : "border-transparent",
              )}
            >
              {line || " "}
            </span>
          );
        })}
      </pre>
    </section>
  );
}

function IndexesPanel({ info, onClose }: { info: TableInfo; onClose: () => void }) {
  return (
    <Panel kind="database-indexes" title={`Indexes of ${info.name}`} onClose={onClose}>
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
