// Database calls in flight at the same time in one mutation, on Convex's backend and on bunvex's: how each call
// settles and the document afterwards. Convex runs a function's writes one at a time in the order they are made, so
// a second delete of the same document fails and two patches both apply. Local only: skipped, with a note, when
// Convex's backend is not there.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { type Backend, ORACLE_BIN, startAll, startBunvex, startConvex } from "../harness/backends.ts";

const ready = existsSync(ORACLE_BIN);
if (!ready) console.warn(`concurrent-writes: skipped, no Convex backend at ${ORACLE_BIN} (set CONVEX_BACKEND_BIN)`);

const APP = resolve(import.meta.dir, "../concurrent-writes-app");
let convex: Backend;
let bunvex: Backend;

beforeAll(async () => {
  if (!ready) return;
  [convex, bunvex] = await startAll([startConvex({ app: APP }), startBunvex({ app: APP })]);
}, 300_000);

afterAll(async () => {
  await Promise.all([convex?.stop(), bunvex?.stop()]);
});

describe.skipIf(!ready)("database calls in flight together in one mutation, against Convex's backend", () => {
  test("each scenario settles the same way and leaves the same document", async () => {
    const names = ((await convex.call("mutation", "ops:names", {})).body as { value: string[] }).value;
    const results: { convex: unknown[]; bunvex: unknown[] } = { convex: [], bunvex: [] };
    for (const scenario of names) {
      for (const [b, out] of [
        [convex, results.convex],
        [bunvex, results.bunvex],
      ] as const)
        out.push({ scenario, ...((await b.call("mutation", "ops:run", { scenario })).body as object) });
    }
    expect(results.bunvex).toEqual(results.convex);
  }, 120_000);
});
