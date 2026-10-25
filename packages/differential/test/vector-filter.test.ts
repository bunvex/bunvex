// Vector search filters on Convex's backend and on bunvex's (STUDY-187 §2.3): `q.or` over a list of tags, and an
// empty `q.or()`, which Convex runs as no filter. Local only: skipped, with a note, when Convex's backend is not there
// (scripts/download-convex-backend.sh, or CONVEX_BACKEND_BIN).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { type Backend, ORACLE_BIN, startAll, startBunvex, startConvex } from "../harness/backends.ts";

const ready = existsSync(ORACLE_BIN);
if (!ready) console.warn(`vector-filter: skipped, no Convex backend at ${ORACLE_BIN} (set CONVEX_BACKEND_BIN)`);

const APP = resolve(import.meta.dir, "../vector-filter-app");
let convex: Backend;
let bunvex: Backend;

async function call(b: Backend, kind: "mutation" | "action", path: string, args: unknown) {
  const r = await fetch(`${b.url}/api/${kind}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, args, format: "json" }),
  });
  return (await r.json()) as { status: string; value?: unknown };
}

beforeAll(async () => {
  if (!ready) return;
  [convex, bunvex] = await startAll([startConvex({ app: APP }), startBunvex({ app: APP })]);
  for (const b of [convex, bunvex]) await call(b, "mutation", "ops:seed", {});
}, 300_000);

afterAll(async () => {
  await Promise.all([convex?.stop(), bunvex?.stop()]);
});

describe.skipIf(!ready)("vector search filters, against Convex's backend", () => {
  test("q.or over tags, an empty q.or() and no filter", async () => {
    const cases = [null, [], ["a"], ["a", "b"], ["z"]];
    const on = (b: Backend) => Promise.all(cases.map((tags) => call(b, "action", "ops:search", { tags })));
    const expected = await on(convex);
    expect(expected.map((r) => r.value)).toEqual([3, 3, 1, 2, 0]);
    expect(await on(bunvex)).toEqual(expected);
  }, 120_000);
});
