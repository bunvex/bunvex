// Writes a mutation leaves unawaited (STUDY-187 §2.1) on Convex's backend and on bunvex's: the rows each mutation
// leaves, into a table the insert creates and into one that exists. Under `vm`, the default executor; under
// `BUNVEX_FUNCTION_SANDBOX=process` an operation chained after the handler settled holds the call to its 1 s limit
// (STUDY-187 §2.11, its own PR). Local only: skipped, with a note, when Convex's backend is not there
// (scripts/download-convex-backend.sh, or CONVEX_BACKEND_BIN).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { type Backend, ORACLE_BIN, startAll, startBunvex, startConvex } from "../harness/backends.ts";

const ready = existsSync(ORACLE_BIN);
if (!ready) console.warn(`dangling-writes: skipped, no Convex backend at ${ORACLE_BIN} (set CONVEX_BACKEND_BIN)`);

const APP = resolve(import.meta.dir, "../dangling-app");
let convex: Backend;
let bunvex: Backend;

beforeAll(async () => {
  if (!ready) return;
  [convex, bunvex] = await startAll([startConvex({ app: APP }), startBunvex({ app: APP })]);
}, 300_000);

afterAll(async () => {
  await Promise.all([convex?.stop(), bunvex?.stop()]);
});

async function call(b: Backend, kind: "mutation" | "query", path: string, args: unknown) {
  const r = await fetch(`${b.url}/api/${kind}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, args, format: "json" }),
  });
  return (await r.json()) as { status: string; value?: unknown };
}

/** Each mutation's status, then every table's rows, on one backend. */
async function play(b: Backend) {
  const out: unknown[] = [];
  for (const [path, table] of [
    ["ops:dangling", "fresh1"],
    ["ops:doublyDangling", "fresh2"],
    ["ops:afterRead", "fresh3"],
    ["ops:dangling", "fresh1"],
    ["ops:doublyDangling", "fresh2"],
    ["ops:afterRead", "fresh2"],
  ] as const)
    out.push((await call(b, "mutation", path, { table })).status);
  for (const table of ["fresh1", "fresh2", "fresh3"]) out.push((await call(b, "query", "ops:count", { table })).value);
  return out;
}

describe.skipIf(!ready)("unawaited writes in a mutation, against Convex's backend", () => {
  test("every unawaited write is committed, as Convex's", async () => {
    const expected = await play(convex);
    expect(expected.slice(6)).toEqual([
      { rows: 2, n: [null, null] },
      { rows: 4, n: [7, null, null, null] },
      { rows: 1, n: [7] },
    ]);
    expect(await play(bunvex)).toEqual(expected);
  }, 120_000);
});
