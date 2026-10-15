// The index list's model (STUDY-149 "Index list"): an entry's kind, the list a source without `watchIndexes` has,
// and when Convex's dashboard suggests a staged index.
import type { IndexInfo, IndexListEntry } from "../data-source.ts";

/** Above this many documents, a backfilling index that is not staged gets the staged-index hint (Convex's). */
export const STAGED_HINT_DOCS = 10_000;

export type IndexKind = "database" | "search" | "vector";

export function indexKind(ix: IndexListEntry): IndexKind {
  if (Array.isArray(ix.fields)) return "database";
  return "searchField" in ix.fields ? "search" : "vector";
}

/** The list a source without `watchIndexes` has: its declared database indexes, as `indexes` would list them. */
export function indexListOf(indexes: IndexInfo[]): IndexListEntry[] {
  return indexes
    .filter((ix) => !ix.system)
    .map((ix) => ({
      name: ix.name,
      staged: false,
      fields: [...ix.fields, "_creationTime"],
      backfill:
        ix.state === "ready"
          ? { state: "done" }
          : {
              state: "backfilling",
              ...(ix.progress && {
                stats: { numDocsIndexed: ix.progress.indexed, totalDocs: ix.progress.total ?? null },
              }),
            },
    }));
}

/** Whether to suggest a staged index: one is backfilling, not staged, on a table past `STAGED_HINT_DOCS`. */
export const suggestsStaging = (list: IndexListEntry[]) =>
  list.some(
    (ix) => ix.backfill.state === "backfilling" && !ix.staged && (ix.backfill.stats?.totalDocs ?? 0) > STAGED_HINT_DOCS,
  );
