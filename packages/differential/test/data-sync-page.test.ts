// A data sync page's size (Convex's 315ea3e, DATA_SYNC_PAGE_SIZE_LIMIT 20 000; STUDY-186 A9), on Convex's backend
// (the oracle) and on bunvex's: a table of 20 005 small rows is walked by id in a first page of 20 000 rows, a second
// of 5, then an empty one up to date. The other two changes of A9 (no hidden tables, the by-ts fallback out of index retention) need an
// import caught mid-write or a moved retention window, which the binary cannot be driven to: packages/server
// `data-sync.test.ts` covers them. Local only: skipped, with a note, when Convex's backend is not there
// (scripts/download-convex-backend.sh, or CONVEX_BACKEND_BIN).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { type Backend, ORACLE_BIN, startAll, startBunvex, startConvex } from "../harness/backends.ts";

const ready = existsSync(ORACLE_BIN);
if (!ready) console.warn(`data-sync-page: skipped, no Convex backend at ${ORACLE_BIN} (set CONVEX_BACKEND_BIN)`);

const APP = resolve(import.meta.dir, "../data-sync-app");
let convex: Backend;
let bunvex: Backend;

beforeAll(async () => {
  if (!ready) return;
  [convex, bunvex] = await startAll([startConvex({ app: APP }), startBunvex({ app: APP })]);
  for (const b of [convex, bunvex]) {
    for (let i = 0; i < 5; i++)
      expect((await b.call("mutation", "rows:put", { n: 4000 })).body).toMatchObject({ status: "success" });
    expect((await b.call("mutation", "rows:put", { n: 5 })).body).toMatchObject({ status: "success" });
  }
}, 300_000);

afterAll(async () => {
  await Promise.all([convex?.stop(), bunvex?.stop()]);
});

const authOf = (b: Backend) => `${b.name === "convex" ? "Convex" : "Bunvex"} ${b.adminKey}`;

/** Pages until up to date: each page's status, truncates and number of values. */
async function pages(b: Backend) {
  const out: { status: string; truncates: unknown; values: number }[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 10; i++) {
    const r = await fetch(`${b.url}/api/v1/data/sync`, {
      method: "POST",
      headers: { authorization: authOf(b), "content-type": "application/json" },
      body: JSON.stringify(cursor === undefined ? {} : { cursor }),
    });
    expect(r.status).toBe(200);
    const page = (await r.json()) as {
      status: { type: string };
      truncates: unknown;
      values: unknown[];
      pagination: { nextCursor: string };
    };
    out.push({ status: page.status.type, truncates: page.truncates, values: page.values.length });
    cursor = page.pagination.nextCursor;
    if (page.status.type === "upToDate") break;
  }
  return out;
}

describe.skipIf(!ready)("a data sync page, against Convex's backend", () => {
  test("20 000 rows a page, by id", async () => {
    const c = await pages(convex);
    const b = await pages(bunvex);
    expect(b).toEqual(c);
    expect(c.map((p) => [p.status, p.values])).toEqual([
      ["snapshotting", 20000],
      ["stale", 5],
      ["upToDate", 0],
    ]);
  }, 120_000);
});
