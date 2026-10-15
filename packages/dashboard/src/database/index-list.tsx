// The Database screen's index list (STUDY-149 "Index list"), as Convex's `IndexList.tsx`: the table's declared
// indexes in three sections — database, search and vector — each with its fields, whether it is staged, and its
// backfill (a progress bar capped at 99 % while it runs, a spinner while the total is unknown, "Backfill completed"
// once a staged index is built); a hint to stage an index when a large table's index blocks the deploy. Live from
// `watchIndexes` (Convex's subscribed `_system/frontend/indexes`); a source without it lists `TableInfo.indexes`.
import { Badge } from "@bunvex/ui/components/badge";
import { cn } from "@bunvex/ui/lib/utils";
import { LoaderCircle } from "lucide-react";
import { useState } from "react";
import { useQueryScope } from "../context.tsx";
import { useWatch } from "../data/live.ts";
import type { DataSourceError, IndexInfo, IndexListEntry } from "../data-source.ts";
import { type IndexKind, indexKind, indexListOf, suggestsStaging } from "./index-list-model.ts";

/** The table's index list: live from the source when it can, else from `fallback`. */
export function useIndexList(
  table: string,
  fallback: IndexInfo[],
): { list: IndexListEntry[] | null | undefined; error: DataSourceError | undefined } {
  const { source, scope } = useQueryScope();
  const [list, setList] = useState<{ table: string; list: IndexListEntry[] | null }>();
  const live = source.watchIndexes !== undefined;
  const error = useWatch<IndexListEntry[] | null>(
    (onIndexes, onError) => source.watchIndexes?.(table, onIndexes, onError) ?? (() => {}),
    (l) => setList({ table, list: l }),
    [source, scope, table],
  );
  if (!live) return { list: indexListOf(fallback), error: undefined };
  return { list: list?.table === table ? list.list : undefined, error };
}

const SECTIONS: { kind: IndexKind; title: string; description: string }[] = [
  {
    kind: "database",
    title: "Indexes",
    description: "Indexes speed up document queries by telling the deployment how to organize the documents.",
  },
  {
    kind: "search",
    title: "Search indexes",
    description: "Search indexes find the documents that approximately match a text search query.",
  },
  {
    kind: "vector",
    title: "Vector indexes",
    description: "Vector indexes find the documents whose vector is nearest a given vector.",
  },
];

export function IndexList({ table, list }: { table: string; list: IndexListEntry[] }) {
  return (
    <div className="flex flex-col gap-6">
      {suggestsStaging(list) && (
        <p role="note" className="border border-info/40 bg-info/10 p-3 text-sm">
          <strong className="font-medium">Hint</strong>: when adding an index to a large table, consider a staged index
          (<code className="font-mono text-xs">{"{ staged: true }"}</code>) so it does not block the deploy.
        </p>
      )}
      {SECTIONS.map((s) => (
        <IndexListSection key={s.kind} {...s} table={table} list={list.filter((ix) => indexKind(ix) === s.kind)} />
      ))}
    </div>
  );
}

function IndexListSection({
  title,
  description,
  table,
  list,
}: {
  title: string;
  description: string;
  table: string;
  list: IndexListEntry[];
}) {
  return (
    <section aria-label={title} className="flex flex-col gap-2">
      <header className="flex flex-col gap-0.5">
        <h3 className="text-sm font-medium">{title}</h3>
        <p className="text-xs text-muted-foreground">{description}</p>
      </header>
      {list.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          <code className="font-mono">{table}</code> has no {title.toLowerCase()}.
        </p>
      ) : (
        <ul className="divide-y border">
          {list.map((ix) => (
            <IndexRow key={ix.name} ix={ix} />
          ))}
        </ul>
      )}
    </section>
  );
}

function IndexRow({ ix }: { ix: IndexListEntry }) {
  const f = ix.fields;
  return (
    <li aria-label={ix.name} className={cn("flex flex-col gap-1 p-3 text-sm", ix.staged && "border-dashed")}>
      <div className="flex items-center gap-2">
        <span className="font-mono font-medium">{ix.name}</span>
        {ix.staged && <Badge variant="secondary">staged</Badge>}
      </div>
      <dl className="flex flex-col gap-0.5 text-xs text-muted-foreground">
        {Array.isArray(f) && <Attribute title="Fields" value={f.join(", ")} />}
        {"searchField" in f && <Attribute title="Search field" value={f.searchField} />}
        {"vectorField" in f && <Attribute title="Vector field" value={f.vectorField} />}
        {!Array.isArray(f) && f.filterFields.length > 0 && (
          <Attribute title="Filter fields" value={f.filterFields.join(", ")} />
        )}
        {"dimensions" in f && <Attribute title="Dimensions" value={String(f.dimensions)} mono={false} />}
      </dl>
      {ix.staged && (
        <p className="text-xs text-muted-foreground">
          Staged indexes are not queryable. To enable this index, remove{" "}
          <code className="font-mono">{"{ staged: true }"}</code> in your <code className="font-mono">schema.ts</code>{" "}
          file.
        </p>
      )}
      <Backfill ix={ix} />
    </li>
  );
}

function Attribute({ title, value, mono = true }: { title: string; value: string; mono?: boolean }) {
  return (
    <div className="flex gap-1">
      <dt className="font-medium text-foreground">{title}:</dt>
      <dd className={cn("min-w-0 break-words", mono && "font-mono")}>{value}</dd>
    </div>
  );
}

function Backfill({ ix }: { ix: IndexListEntry }) {
  const { state, stats } = ix.backfill;
  if (state === "done") return null;
  const known = state === "backfilled" || (stats !== undefined && stats.totalDocs !== null);
  // the count is an estimate that can pass the total (documents added meanwhile are not counted in it): 99 % at most
  const share =
    state === "backfilled"
      ? 1
      : known && stats!.totalDocs! > 0
        ? Math.min(0.99, stats!.numDocsIndexed / stats!.totalDocs!)
        : known
          ? 0.99
          : null;
  return (
    <div className="flex flex-col gap-1 text-xs text-muted-foreground">
      <span className="flex items-center gap-1.5">
        {share === null && (
          <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin motion-reduce:animate-none" />
        )}
        {state === "backfilled" ? "Backfill completed" : "Backfill in progress"}
      </span>
      {share !== null && (
        <div className="flex items-center gap-2">
          <div
            role="progressbar"
            aria-label={`Backfill of ${ix.name}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(share * 100)}
            className="h-1.5 w-32 shrink-0 bg-muted"
          >
            <div
              className={cn("h-full", state === "backfilled" ? "bg-success" : "bg-warning")}
              style={{ width: `${share * 100}%` }}
            />
          </div>
          <span className="tabular-nums">{Math.round(share * 100)}%</span>
        </div>
      )}
    </div>
  );
}
