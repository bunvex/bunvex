// A CSV import's empty cells on Convex's backend and on bunvex's (STUDY-187 §2.2): a field the active schema has
// optional at the top level, in any member of a union, is dropped; a required one, and a table outside the schema,
// keep "". Local only: skipped, with a note, when Convex's backend is not there (scripts/download-convex-backend.sh,
// or CONVEX_BACKEND_BIN).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { type Backend, ORACLE_BIN, startAll, startBunvex, startConvex } from "../harness/backends.ts";

const ready = existsSync(ORACLE_BIN);
if (!ready) console.warn(`csv-import: skipped, no Convex backend at ${ORACLE_BIN} (set CONVEX_BACKEND_BIN)`);

const APP = resolve(import.meta.dir, "../csv-import-app");
let convex: Backend;
let bunvex: Backend;

beforeAll(async () => {
  if (!ready) return;
  [convex, bunvex] = await startAll([startConvex({ app: APP }), startBunvex({ app: APP })]);
}, 300_000);

afterAll(async () => {
  await Promise.all([convex?.stop(), bunvex?.stop()]);
});

async function importCsv(b: Backend, table: string, csv: string) {
  const scheme = b.name === "convex" ? "Convex" : "Bunvex";
  const r = await fetch(`${b.url}/api/import?format=csv&tableName=${table}`, {
    method: "POST",
    headers: { authorization: `${scheme} ${b.adminKey}`, "content-type": "text/csv" },
    body: csv,
  });
  return { status: r.status, body: await r.json() };
}

async function play(b: Backend) {
  const out: unknown[] = [];
  for (const [table, csv] of [
    ["people", "a,b,c\n,,\n1,s,t\n"],
    ["either", "k,p\nx,\nx,2\n"],
    ["loose", "a,b\n,\n"],
  ] as const) {
    out.push(await importCsv(b, table, csv));
    out.push(await b.call("query", "docs:all", { table }));
  }
  return out;
}

describe.skipIf(!ready)("a CSV import's empty cells, against Convex's backend", () => {
  test("optional fields dropped, required ones and tables outside the schema keep the empty string", async () => {
    const expected = await play(convex);
    expect(await play(bunvex)).toEqual(expected);
  }, 120_000);
});
