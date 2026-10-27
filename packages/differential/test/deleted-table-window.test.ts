// A deleted table through the document retention window (STUDY-195 §1, DV-580), on Convex's backend (the oracle)
// and on bunvex's: after `delete_tables` drops `ta`, a new table `tc` does not take `ta`'s number, and an id of `ta`
// does not normalize as an id of `tc`. Convex keeps the deleted table's `_tables` row, and so its number, until
// retention passes the deletion (14 days); bunvex freed it within seconds. Local only: skipped, with a note, when
// Convex's backend is not there (scripts/download-convex-backend.sh, or CONVEX_BACKEND_BIN).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { decodeId } from "bunvex/values";
import { type Backend, ORACLE_BIN, startAll, startBunvex, startConvex } from "../harness/backends.ts";

const ready = existsSync(ORACLE_BIN);
if (!ready) console.warn(`deleted-table-window: skipped, no Convex backend at ${ORACLE_BIN} (set CONVEX_BACKEND_BIN)`);

const APP = resolve(import.meta.dir, "../deleted-table-app");
let convex: Backend;
let bunvex: Backend;

beforeAll(async () => {
  if (!ready) return;
  [convex, bunvex] = await startAll([startConvex({ app: APP }), startBunvex({ app: APP })]);
}, 300_000);

afterAll(async () => {
  await Promise.all([convex?.stop(), bunvex?.stop()]);
});

const authOf = (b: Backend) => `${b.name === "convex" ? "Convex" : "Bunvex"} ${b.adminKey}`;
const value = async (b: Backend, kind: "query" | "mutation", path: string, args: object) => {
  const r = (await b.call(kind, path, args)).body as { status: string; value: unknown };
  expect(r.status).toBe("success");
  return r.value;
};

async function play(b: Backend) {
  const old = (await value(b, "mutation", "rows:put", { table: "ta" })) as string;
  await value(b, "mutation", "rows:put", { table: "tb" });
  const r = await fetch(`${b.url}/api/delete_tables`, {
    method: "POST",
    headers: { authorization: authOf(b), "content-type": "application/json" },
    body: JSON.stringify({ tableNames: ["ta"] }),
  });
  expect(r.status).toBe(200);
  // Time for a background purge to have run (bunvex's took well under a second).
  await Bun.sleep(3000);
  const fresh = (await value(b, "mutation", "rows:put", { table: "tc" })) as string;
  return {
    sameNumber: decodeId(fresh).tableNumber === decodeId(old).tableNumber,
    normalized: await value(b, "query", "rows:normalize", { table: "tc", id: old }),
    stillGone: await value(b, "query", "rows:normalize", { table: "ta", id: old }),
  };
}

describe.skipIf(!ready)("a deleted table's number inside the retention window, against Convex's backend", () => {
  test("a new table takes another number; an old id is no id of it", async () => {
    const [c, b] = await Promise.all([play(convex), play(bunvex)]);
    expect(b).toEqual(c);
    expect(c).toEqual({ sameNumber: false, normalized: null, stillGone: null });
  }, 120_000);
});
