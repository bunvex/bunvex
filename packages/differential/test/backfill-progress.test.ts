// An index backfill's progress row (STUDY-174 S1): a push adds an index to a table that already has documents; once
// the backfill is done, its `_index_backfills` row is read straight from each backend's SQLite store and compared:
// the documents indexed, the table's count, and the cursor (Convex's `backfill_from_ts` flushes its last progress, so
// the row counts every document and its cursor names the last one). Local only: skipped, with a note, when Convex's
// backend is not there (scripts/download-convex-backend.sh, or CONVEX_BACKEND_BIN).
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Backend, newStore, ORACLE_BIN, startBunvex, startConvex } from "../harness/backends.ts";

const ready = existsSync(ORACLE_BIN);
if (!ready) console.warn(`backfill-progress: skipped, no Convex backend at ${ORACLE_BIN} (set CONVEX_BACKEND_BIN)`);

const APP = resolve(import.meta.dir, "../backfill-progress-app");
const INDEXED = `import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  items: defineTable({ n: v.number() }).index("by_n", ["n"]),
});
`;
const N = 300;

type Json = Record<string, unknown>;
/** An int64 as both stores keep it in JSON: `{"$integer": base64 of 8 little-endian bytes}`. */
const int64 = (v: unknown) =>
  v === null ? null : Buffer.from((v as { $integer: string }).$integer, "base64").readBigInt64LE(0);

/** The newest live version of every document holding `numDocsIndexed`: the `_index_backfills` rows. */
function backfillRows(file: string) {
  const db = new Database(file, { readonly: true });
  try {
    const rows = db
      .query(
        `select d.json_value as j from documents d
         join (select table_id, id, max(ts) as ts from documents group by table_id, id) m
           on d.table_id = m.table_id and d.id = m.id and d.ts = m.ts
         where d.deleted = 0`,
      )
      .all() as { j: string | Uint8Array }[];
    return rows
      .map((r) => JSON.parse(typeof r.j === "string" ? r.j : new TextDecoder().decode(r.j)) as Json)
      .filter((d) => "numDocsIndexed" in d);
  } finally {
    db.close();
  }
}

async function value(b: Backend, path: string, args: unknown) {
  const r = await b.call("mutation", path, args);
  if (!r.ok) throw new Error(`${b.name} ${path}: ${r.status} ${JSON.stringify(r.body)}`);
}

/** The database index's row once a push added `by_n` over `N` documents. */
async function progressAfterPush(start: typeof startConvex) {
  const store = newStore();
  try {
    const a = await start({ store, app: APP });
    await value(a, "items:add", { count: N });
    await a.stop();
    // The same store, the schema with the index: the deploy waits for its backfill.
    const b = await start({
      store,
      app: APP,
      prepare: (project, dir) =>
        writeFileSync(join(project, dir, "schema.ts"), INDEXED.replaceAll('"convex/', `"${dir}/`)),
    });
    await Bun.sleep(1500); // the worker records its last progress after the index is done
    await b.stop();
    // The database index's row: Convex's has a cursor (a search index's has none).
    const rows = backfillRows(join(store.dir, "store.sqlite3")).filter((r) => r.cursor !== null);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    const cursor = row.cursor as { cursor: string | null };
    return {
      numDocsIndexed: int64(row.numDocsIndexed),
      totalDocs: int64(row.totalDocs),
      cursorIsString: typeof cursor.cursor === "string",
    };
  } finally {
    rmSync(store.dir, { recursive: true, force: true });
  }
}

describe.skipIf(!ready)("an index backfill's progress row (STUDY-174 S1)", () => {
  test("after the backfill: every document counted, the cursor at the last one, as Convex's", async () => {
    const convex = await progressAfterPush(startConvex);
    expect(convex).toEqual({ numDocsIndexed: BigInt(N), totalDocs: BigInt(N), cursorIsString: true });
    const bunvex = await progressAfterPush(startBunvex);
    expect(bunvex).toEqual(convex);
  }, 180_000);
});
