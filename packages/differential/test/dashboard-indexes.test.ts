// The Data screen's index list (STUDY-149 "Index list"): `_system/frontend/indexes` for a table with database,
// search and vector indexes, staged and not, and for a table with none, on Convex's backend (the oracle) and on
// bunvex's, for the app of `indexes-app/`; the answers compared whole. The order is `_index`'s id order on both
// (random ids), so they are compared by name. Local only: skipped, with a note, when Convex's backend is not there
// (scripts/download-convex-backend.sh, or CONVEX_BACKEND_BIN).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { type Backend, ORACLE_BIN, startAll, startBunvex, startConvex } from "../harness/backends.ts";

const ready = existsSync(ORACLE_BIN);
if (!ready) console.warn(`dashboard-indexes: skipped, no Convex backend at ${ORACLE_BIN} (set CONVEX_BACKEND_BIN)`);

const APP = resolve(import.meta.dir, "../indexes-app");
let convex: Backend;
let bunvex: Backend;

type Index = { name: string; backfill: { state: string } };

/** `indexes` for `tableName` as an admin, sorted by name. */
async function indexes(b: Backend, tableName: string): Promise<Index[] | null> {
  const r = await fetch(`${b.url}/api/query`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `${b.name === "convex" ? "Convex" : "Bunvex"} ${b.adminKey}`,
    },
    body: JSON.stringify({
      path: "_system/frontend/indexes",
      args: { tableName, tableNamespace: null },
      format: "json",
    }),
  });
  const body = (await r.json()) as { status: string; value?: Index[] | null; errorMessage?: string };
  if (body.status !== "success") throw new Error(`${b.name}: ${body.errorMessage}`);
  return body.value ? [...body.value].sort((x, y) => x.name.localeCompare(y.name)) : (body.value ?? null);
}

/** The list once no staged index is still backfilling (each backend fills them after the push, in its own time). */
async function settled(b: Backend, tableName: string): Promise<Index[] | null> {
  for (let i = 0; i < 40; i++) {
    const list = await indexes(b, tableName);
    if (!list?.some((ix) => ix.backfill.state === "backfilling")) return list;
    await Bun.sleep(100);
  }
  return indexes(b, tableName);
}

describe.skipIf(!ready)("the index list on Convex and on bunvex", () => {
  beforeAll(async () => {
    [convex, bunvex] = await startAll([startConvex({ app: APP }), startBunvex({ app: APP })]);
    for (const b of [convex, bunvex]) {
      const r = await b.call("mutation", "docs:add", { n: 20 });
      if (!r.ok) throw new Error(`${b.name}: ${JSON.stringify(r.body)}`);
    }
  }, 300_000);
  afterAll(async () => {
    await Promise.all([convex?.stop(), bunvex?.stop()]);
  });

  test("every kind of index, staged and not", async () => {
    const [c, b] = await Promise.all([settled(convex, "docs"), settled(bunvex, "docs")]);
    expect(b).toEqual(c);
    // what the comparison stands on: one of each kind, staged ones left backfilled
    expect(c?.map((ix) => ix.name)).toEqual([
      "by_author",
      "by_author_n",
      "by_e",
      "by_f_staged",
      "by_n_staged",
      "search_body",
      "search_staged",
    ]);
  });

  test("GET /api/get_indexes", async () => {
    const get = async (b: Backend) => {
      await settled(b, "docs");
      const r = await fetch(`${b.url}/api/get_indexes`, {
        headers: { authorization: `${b.name === "convex" ? "Convex" : "Bunvex"} ${b.adminKey}` },
      });
      const body = (await r.json()) as { indexes: { table: string; name: string }[] };
      return body.indexes.sort((x, y) => `${x.table}.${x.name}`.localeCompare(`${y.table}.${y.name}`));
    };
    expect(await get(bunvex)).toEqual(await get(convex));
  });

  test("a table with none, and a table that does not exist", async () => {
    for (const table of ["plain", "nope"]) expect(await indexes(bunvex, table)).toEqual(await indexes(convex, table));
  });
});
