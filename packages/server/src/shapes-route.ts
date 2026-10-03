// `GET /api/shapes2` (STUDY-52), as Convex's dashboard route (crates/local_backend/src/dashboard.rs): each
// user table's inferred shape in the dashboard's form. Computed here from the table's documents at one
// snapshot when asked (A1 of STUDY-52: Convex serves shapes checkpointed every few minutes).
import { type Engine, reduceShape, shapeOf, UnionBuilder } from "@bunvex/core";
import type { Value } from "@bunvex/values";

export async function tableShapes(engine: Engine): Promise<Record<string, unknown>> {
  const at = engine.committer.visibleTs;
  const catalog = engine.catalog;
  const tables = [...catalog.tables.values()].filter((t) => !t.name.startsWith("_"));
  const byNumber = new Map([...catalog.tables.values()].map((t) => [t.number, t.name]));
  const out: Record<string, unknown> = {};
  for (const t of tables.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const shape = new UnionBuilder();
    let last: string | null = null;
    for (;;) {
      const page = (await engine.query(
        (db) =>
          db.asSystem(() =>
            db
              .queryDef(t)
              .withIndex("by_id", (q) => (last === null ? q : q.gt("_id", last)))
              .take(1000),
          ),
        undefined,
        undefined,
        undefined,
        at,
      )) as Record<string, Value>[];
      for (const d of page) shape.push(shapeOf(d));
      if (page.length < 1000) break;
      last = page[page.length - 1]!._id as string;
    }
    out[t.name] = reduceShape(shape.build(), (n) => byNumber.get(n));
  }
  return out;
}
