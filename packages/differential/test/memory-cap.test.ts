// A function's memory cap (STUDY-188 §X17, R12, DV-553) on Convex's backend (the oracle) and on bunvex's under the
// `process` function sandbox: the queries, mutations and actions of `memory-app/` that hold far more than a function
// may (a 512 MiB and a 4 GiB `ArrayBuffer`, a 512 MiB `Blob`, typed arrays, objects, strings) fail with Convex's
// message alone, whatever they catch; one under the cap and one that allocates far more than it in garbage succeed;
// the next call after a failure succeeds. Compared over HTTP (the status and the body, without the log lines: the
// failed call's lines are lost with its child under `process`, a known gap of §X17), over the sync socket, and in the
// function log (the run's error). Under `vm` (the default), nothing is capped (DV-553): checked on one probe. Local
// only: skipped, with a note, when Convex's backend is not there (scripts/download-convex-backend.sh, or
// CONVEX_BACKEND_BIN).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { ConvexClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { type Backend, ORACLE_BIN, startAll, startBunvex, startConvex } from "../harness/backends.ts";

const ready = existsSync(ORACLE_BIN);
if (!ready) console.warn(`memory-cap: skipped, no Convex backend at ${ORACLE_BIN} (set CONVEX_BACKEND_BIN)`);

const APP = resolve(import.meta.dir, "../memory-app");
const PROCESS = { BUNVEX_FUNCTION_SANDBOX: "process", BUNVEX_FUNCTION_SANDBOX_ISOLATION: "none" };
const OOM = "JavaScript execution ran out of memory (maximum memory usage: 64 MB)\n";

let convex: Backend;
let sandboxed: Backend;
let bunvex: Backend;

beforeAll(async () => {
  if (!ready) return;
  [convex, sandboxed, bunvex] = await startAll([
    startConvex({ app: APP }),
    startBunvex({ app: APP, env: PROCESS }),
    startBunvex({ app: APP }),
  ]);
}, 300_000);

afterAll(async () => {
  await Promise.all([convex?.stop(), sandboxed?.stop(), bunvex?.stop()]);
});

const KINDS = ["query", "mutation", "action"] as const;
const OVER = ["arrayBuffer", "arrayBuffer4g", "blob", "typedArrays", "objects", "strings"];

/** The HTTP status and body, without its request id and its log lines. */
async function call(b: Backend, kind: (typeof KINDS)[number], path: string, args: object) {
  const r = await b.call(kind, path, args);
  const { logLines: _, ...body } = r.body as Record<string, unknown> & { errorMessage?: string; logLines?: string[] };
  if (body.errorMessage !== undefined) body.errorMessage = body.errorMessage.replace(/^\[Request ID: \w+\] /, "");
  return { status: r.status, body };
}

const auth = (b: Backend) => ({ authorization: `${b.name === "convex" ? "Convex" : "Bunvex"} ${b.adminKey}` });

/** The function log's completions of `ops:<kind>`, in order: each run's error, or null. */
async function errors(b: Backend, n: number) {
  let entries: { kind: string; identifier: string; error?: string | null }[] = [];
  for (let i = 0; i < 100; i++) {
    const r = await fetch(`${b.url}/api/stream_function_logs?cursor=0`, { headers: auth(b) });
    entries = ((await r.json()) as { entries: typeof entries }).entries.filter(
      (e) => e.kind === "Completion" && /^ops(\.js)?:(query|mutation|action)$/.test(e.identifier),
    );
    if (entries.length >= n) break;
    await Bun.sleep(100);
  }
  return entries.map((e) => e.error ?? null);
}

describe.skipIf(!ready)("a function's memory cap, against Convex's backend", () => {
  test("over HTTP: past the cap, Convex's message alone; under it, and garbage, the value; the next call runs", async () => {
    const expected: (string | null)[] = [];
    for (const kind of KINDS)
      for (const probe of [...OVER, "under", "churn"]) {
        const c = await call(convex, kind, `ops:${kind}`, { probe });
        const s = await call(sandboxed, kind, `ops:${kind}`, { probe });
        expect({ kind, probe, ...s }).toEqual({ kind, probe, ...c });
        expected.push(OVER.includes(probe) ? OOM : null);
        for (const b of [convex, sandboxed])
          expect(await call(b, "query", "ops:ping", {})).toEqual({
            status: 200,
            body: { status: "success", value: "pong" },
          });
      }
    // What the oracle answers, spelled out.
    expect(await call(convex, "query", "ops:query", { probe: "blob" })).toEqual({
      status: 200,
      body: { status: "error", errorMessage: `Server Error\n${OOM}` },
    });
    expect(await call(convex, "action", "ops:action", { probe: "under" })).toEqual({
      status: 200,
      body: { status: "success", value: { value: 33_654_432 } },
    });
    // The function log: each run's error, Convex's message alone.
    const c = await errors(convex, expected.length + 2);
    expect(c.slice(0, expected.length)).toEqual(expected);
    expect((await errors(sandboxed, expected.length)).slice(0, expected.length)).toEqual(expected);
  }, 300_000);

  test("over the sync socket: the same errors", async () => {
    const sync = async (b: Backend) => {
      const client = new ConvexClient(b.url, { unsavedChangesWarning: false });
      const strip = (e: Error) => e.message.replace(/\[Request ID: \w+\] /, "");
      try {
        return {
          query: await client.query(makeFunctionReference<"query">("ops:query"), { probe: "arrayBuffer" }).catch(strip),
          mutation: await client
            .mutation(makeFunctionReference<"mutation">("ops:mutation"), { probe: "objects" })
            .catch(strip),
          action: await client.action(makeFunctionReference<"action">("ops:action"), { probe: "blob" }).catch(strip),
        };
      } finally {
        await client.close();
      }
    };
    const c = await sync(convex);
    expect(c.query).toBe(`[CONVEX Q(ops:query)] Server Error\n${OOM}\n  Called by client`);
    expect(await sync(sandboxed)).toEqual(c);
  }, 120_000);

  test("under vm, nothing is capped (DV-553)", async () => {
    expect(await call(bunvex, "query", "ops:query", { probe: "arrayBuffer" })).toEqual({
      status: 200,
      body: { status: "success", value: { value: 512 * 1024 * 1024 } },
    });
  });
});
