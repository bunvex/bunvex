// A query's or mutation's result changed after its handler returned (STUDY-188 §X19 a), on Convex's backend (the
// oracle) and on bunvex's, under `vm` and under `process`: Convex's `asyncTests:queryDangling`, a read left unawaited
// whose `.then` pushes into the array the handler returned, and the same into an object, from a mutation, and
// through a nested call; and pushes after 0 to 4 microtask turns. Convex serializes the result two microtask turns
// after the handler's promise is fulfilled, before the read answers: `[]` whether the table is empty or not. Local
// only: skipped, with a note, when Convex's backend is not there (scripts/download-convex-backend.sh, or
// CONVEX_BACKEND_BIN).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { type Backend, ORACLE_BIN, startAll, startBunvex, startConvex } from "../harness/backends.ts";

const ready = existsSync(ORACLE_BIN);
if (!ready) console.warn(`dangling-result: skipped, no Convex backend at ${ORACLE_BIN} (set CONVEX_BACKEND_BIN)`);

const APP = resolve(import.meta.dir, "../dangling-result-app");
let convex: Backend;
let bunvex: Backend;
let sandboxed: Backend;

beforeAll(async () => {
  if (!ready) return;
  [convex, bunvex, sandboxed] = await startAll([
    startConvex({ app: APP }),
    startBunvex({ app: APP }),
    startBunvex({ app: APP, env: { BUNVEX_FUNCTION_SANDBOX: "process", BUNVEX_FUNCTION_SANDBOX_ISOLATION: "none" } }),
  ]);
}, 300_000);

afterAll(async () => {
  await Promise.all([convex?.stop(), bunvex?.stop(), sandboxed?.stop()]);
});

const CALLS = [
  ["query", "ops:queryDangling"],
  ["query", "ops:objectDangling"],
  ["mutation", "ops:mutationDangling"],
  ["query", "ops:nestedDangling"],
  ["query", "ops:microtasks"],
] as const;

/** Each call's answer, with an empty table, then with one document. */
async function play(b: Backend) {
  const out: unknown[] = [];
  for (const phase of ["empty", "one document"]) {
    if (phase === "one document") await b.call("mutation", "ops:insert", {});
    for (const [kind, path] of CALLS) out.push([phase, path, (await b.call(kind, path, {})).body]);
  }
  return out;
}

describe.skipIf(!ready)("a result changed after the handler returned, against Convex's backend", () => {
  test("what the handler returned, as it stood when its promise settled", async () => {
    const expected = await play(convex);
    const value = (v: unknown) => ({ status: "success", value: v });
    expect(expected).toEqual(
      ["empty", "one document"].flatMap((phase) => [
        [phase, "ops:queryDangling", value([])],
        [phase, "ops:objectDangling", value({ a: 1 })],
        [phase, "ops:mutationDangling", value([])],
        [phase, "ops:nestedDangling", value([])],
        // Read two microtask turns after the handler's promise settled.
        [phase, "ops:microtasks", value([0, 1])],
      ]),
    );
    expect(await play(bunvex)).toEqual(expected);
    expect(await play(sandboxed)).toEqual(expected);
  }, 120_000);
});
