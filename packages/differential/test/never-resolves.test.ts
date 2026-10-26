// A query or mutation whose returned promise can never resolve (STUDY-188 §X16), on Convex's backend (the oracle) and
// on bunvex's, under `vm` and under `process`: Convex fails it at once with "Returned promise will never resolve", its
// message alone (no "Uncaught", no frames), over `/api/query`, `/api/mutation` and the sync socket; a nested one fails
// in its caller, which can catch it. Handlers that wait on real work answer the same on both: reads chained one after
// the other, nested and stale-snapshot queries, a large `crypto.subtle.digest`. A nested call's error is compared
// without the frames after it (where its caller called: STUDY-95's, not this study's). Local only: skipped, with a
// note, when Convex's backend is not there (scripts/download-convex-backend.sh, or CONVEX_BACKEND_BIN).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { ConvexClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { type Backend, ORACLE_BIN, startAll, startBunvex, startConvex } from "../harness/backends.ts";

const ready = existsSync(ORACLE_BIN);
if (!ready) console.warn(`never-resolves: skipped, no Convex backend at ${ORACLE_BIN} (set CONVEX_BACKEND_BIN)`);

const APP = resolve(import.meta.dir, "../never-resolves-app");
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
  for (const b of [convex, bunvex, sandboxed]) await b.call("mutation", "ops:seed", { n: 3 });
}, 300_000);

afterAll(async () => {
  await Promise.all([convex?.stop(), bunvex?.stop(), sandboxed?.stop()]);
});

/** The error's text without its request id and its frames (a nested call's caller's, STUDY-95's). */
const text = (s: string) => s.replace(/\[Request ID: [0-9a-f]{16}\] /, "").replace(/^ {4}at .*\n/gm, "");

/** The HTTP status and JSON body over `/api/{kind}`, and how long it took. */
async function http(b: Backend, kind: "query" | "mutation", path: string) {
  const start = performance.now();
  const r = await fetch(`${b.url}/api/${kind}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, args: {}, format: "json" }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await r.json()) as { status: string; value?: unknown; errorMessage?: string };
  const ms = performance.now() - start;
  const answer = body.errorMessage === undefined ? body : { ...body, errorMessage: text(body.errorMessage) };
  return { status: r.status, body: answer, ms };
}

/** Over the sync socket, with Convex's client: a subscription's first answer, and a mutation's. */
async function sync(b: Backend) {
  const client = new ConvexClient(b.url, { unsavedChangesWarning: false });
  const out: Record<string, unknown> = {};
  try {
    for (const path of ["ops:neverQuery", "ops:neverNested", "ops:chained"])
      out[path] = await new Promise((done) => {
        const stop = client.onUpdate(
          makeFunctionReference<"query">(path),
          {},
          (value) => {
            stop();
            done({ value });
          },
          (e) => {
            stop();
            done({ error: text(e.message) });
          },
        );
      });
    out["ops:neverMutation"] = await client.mutation(makeFunctionReference<"mutation">("ops:neverMutation"), {}).then(
      (value) => ({ value }),
      (e: Error) => ({ error: text(e.message) }),
    );
  } finally {
    await client.close();
  }
  return out;
}

const CALLS = [
  ["query", "ops:neverQuery"],
  ["mutation", "ops:neverMutation"],
  ["query", "ops:neverAfterRead"],
  ["query", "ops:neverNested"],
  ["query", "ops:neverNestedCaught"],
  ["query", "ops:chained"],
  ["mutation", "ops:chainedMutation"],
  ["query", "ops:digest"],
] as const;

describe.skipIf(!ready)("a promise that can never resolve, against Convex's backend", () => {
  test("over HTTP: the same status and body, at once", async () => {
    for (const [kind, path] of CALLS) {
      const c = await http(convex, kind, path);
      for (const b of [bunvex, sandboxed]) {
        const r = await http(b, kind, path);
        expect({ path, status: r.status, body: r.body }).toEqual({ path, status: c.status, body: c.body });
        expect(r.ms).toBeLessThan(1000);
      }
    }
    expect((await http(convex, "query", "ops:neverQuery")).body).toEqual({
      status: "error",
      errorMessage: "Server Error\nReturned promise will never resolve\n",
    });
    expect((await http(convex, "query", "ops:neverNestedCaught")).body).toEqual({
      status: "success",
      value: { name: "Error", message: "Returned promise will never resolve\n", rows: 3 },
    });
    // The mutation that never resolved wrote nothing.
    for (const b of [convex, bunvex, sandboxed])
      expect((await http(b, "query", "ops:chained")).body).toEqual({
        status: "success",
        value: { out: [0, 1, 2], rows: 3 },
      });
  }, 60_000);

  test("over the sync socket: the same errors", async () => {
    const c = await sync(convex);
    expect(c["ops:neverQuery"]).toEqual({
      error: "[CONVEX Q(ops:neverQuery)] Server Error\nReturned promise will never resolve\n\n  Called by client",
    });
    expect(await sync(bunvex)).toEqual(c);
    expect(await sync(sandboxed)).toEqual(c);
  }, 60_000);
});
