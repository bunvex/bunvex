// `GET /api/shapes2` (STUDY-52), as Convex's dashboard route (crates/local_backend/src/dashboard.rs): each
// user table's inferred shape in the dashboard's form, from the table summaries (kept by every commit,
// STUDY-52 PR 2). Before the summaries are built, every table is `Unknown`, as Convex's before its first
// checkpoint.
import { type Engine, reduceShape } from "@bunvex/core";

export async function tableShapes(engine: Engine): Promise<Record<string, unknown>> {
  const catalog = engine.catalog;
  const out: Record<string, unknown> = {};
  const tables = [...catalog.tables.values()].filter((t) => !t.name.startsWith("_"));
  for (const t of tables.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)))
    out[t.name] = engine.tableSummaries.ready
      ? reduceShape(engine.tableSummaries.get(t.id).shape, (n) => catalog.publicNameOf(n))
      : { type: "Unknown" };
  return out;
}
