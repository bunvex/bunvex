// An id of a table number the deployment does not have (STUDY-187 §2.9), on Convex's backend and on bunvex's: `get`
// answers null; `delete`, `patch` and `replace` fail with Convex's words. Local only: skipped, with a note, when
// Convex's backend is not there (scripts/download-convex-backend.sh, or CONVEX_BACKEND_BIN).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { type Backend, ORACLE_BIN, startAll, startBunvex, startConvex } from "../harness/backends.ts";

const ready = existsSync(ORACLE_BIN);
if (!ready) console.warn(`missing-table-id: skipped, no Convex backend at ${ORACLE_BIN} (set CONVEX_BACKEND_BIN)`);

const APP = resolve(import.meta.dir, "../missing-table-app");
let convex: Backend;
let bunvex: Backend;

beforeAll(async () => {
  if (!ready) return;
  [convex, bunvex] = await startAll([startConvex({ app: APP }), startBunvex({ app: APP })]);
  for (const b of [convex, bunvex]) await b.call("mutation", "ops:seed", {});
}, 300_000);

afterAll(async () => {
  await Promise.all([convex?.stop(), bunvex?.stop()]);
});

describe.skipIf(!ready)("an id of a table that does not exist, against Convex's backend", () => {
  test("get is null; delete, patch and replace fail with Convex's words", async () => {
    // Table number 777777, which neither backend has, internal id 16 bytes of 7: `encodeId(777777, new Uint8Array(16).fill(7))`.
    const id = "p6y2y1r70w3ge1r70w3ge1r70w3ge1rc68";
    const on = async (b: Backend) => [
      await b.call("mutation", "ops:writes", { id }),
      await b.call("query", "ops:read", { id }),
    ];
    const expected = await on(convex);
    expect(await on(bunvex)).toEqual(expected);
  }, 120_000);
});
