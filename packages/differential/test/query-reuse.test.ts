// A query used again (STUDY-188 §X9) on Convex's backend (the oracle) and on bunvex's, under `vm` and under the
// `process` function sandbox, for the app of `query-reuse-app/`: every pair of steps (an iteration run to its end or
// left by a `break`, `collect`, `take`, `first`, `unique`, `paginate`, an operator, a bare `[Symbol.asyncIterator]()`,
// `next()`, `return()`, `count()`) on the same query, and a few longer runs, for each kind of query object. Each
// step's outcome is compared, an error by its message (STUDY-150's text). Local only: skipped, with a note, when
// Convex's backend is not there (scripts/download-convex-backend.sh, or CONVEX_BACKEND_BIN).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { type Backend, ORACLE_BIN, startAll, startBunvex, startConvex } from "../harness/backends.ts";
import { errorText } from "../harness/compare.ts";

const ready = existsSync(ORACLE_BIN);
if (!ready) console.warn(`query-reuse: skipped, no Convex backend at ${ORACLE_BIN} (set CONVEX_BACKEND_BIN)`);

const APP = resolve(import.meta.dir, "../query-reuse-app");
const PROCESS = { BUNVEX_FUNCTION_SANDBOX: "process", BUNVEX_FUNCTION_SANDBOX_ISOLATION: "none" };
let convex: Backend;
let vm: Backend;
let sandbox: Backend;

const BASES = ["init", "scan", "ordered", "missing", "sysinit", "sysscan"];
const FIRST = ["iter", "break", "collect", "take", "first", "unique", "paginate", "start", "next", "return", "count"];
const THEN = [
  ...["iter", "break", "collect", "take", "first", "paginate"],
  ...["filter", "order", "limit", "withIndex", "start", "itnext", "next", "return", "count"],
];
const CASES: string[][] = [
  ...FIRST.flatMap((a) => THEN.map((b) => [a, b])),
  // a stream read past its end, left by `return()`, read again after its first document
  ["start", "itnext", "itnext", "itnext", "itnext"],
  ["start", "itreturn", "itnext"],
  ["next", "next", "next", "next"],
  ["start", "itnext", "collect"],
  ["start", "itnext", "iter"],
  ["order", "collect"],
];

describe.skipIf(!ready)("a query used again, on Convex and on bunvex", () => {
  beforeAll(async () => {
    [convex, vm, sandbox] = await startAll([
      startConvex({ app: APP }),
      startBunvex({ app: APP }),
      startBunvex({ app: APP, env: PROCESS }),
    ]);
    for (const b of [convex, vm, sandbox]) await b.call("mutation", "queries:seed", {});
  }, 300_000);
  afterAll(async () => {
    await Promise.all([convex?.stop(), vm?.stop(), sandbox?.stop()]);
  });

  // An outcome as compared: a message without what differs by design. A TypeError for a method a stage lacks is
  // the engine's own text (V8's on Convex, JavaScriptCore's on bunvex, DV-06), so only its class is compared.
  const outcomes = async (b: Backend, base: string, steps: string[]) => {
    const { body } = await b.call("query", "queries:run", { base, steps });
    const a = body as { status: string; value?: string[]; errorMessage?: string };
    if (a.status !== "success") return { error: errorText(a.errorMessage ?? "") };
    return a.value!.map((o) => (o.startsWith("err:TypeError:") ? "err:TypeError" : errorText(o)));
  };

  test("every step answers the same", async () => {
    const runs = BASES.flatMap((base) => CASES.map((steps) => ({ base, steps })));
    const got = await Promise.all(
      runs.map(async ({ base, steps }) => {
        const [c, v, s] = await Promise.all([convex, vm, sandbox].map((b) => outcomes(b, base, steps)));
        return { base, steps: steps.join(","), convex: c, vm: v, sandbox: s };
      }),
    );
    // Under the sandbox a query starts on the host, at its first `next()`: a start that fails (`missing`) throws there,
    // not from a bare `[Symbol.asyncIterator]()` (a `for await` fails at the same statement either way).
    const lazyStart = (r: { base: string; steps: string }) => r.base === "missing" && r.steps.includes("start");
    const wrong = got.filter(
      (r) => !Bun.deepEquals(r.convex, r.vm) || (!lazyStart(r) && !Bun.deepEquals(r.convex, r.sandbox)),
    );
    expect(wrong).toEqual([]);
    // The probes of STUDY-188 §X9, as Convex answers them.
    const at = (base: string, steps: string) => got.find((r) => r.base === base && r.steps === steps)!.convex;
    const consumed = "err:Error:This query is closed and can't emit any more values.";
    const chained = "err:Error:This query has been chained with another operator and can't be reused.";
    expect(at("scan", "iter,iter")).toEqual(["ok:2", consumed]);
    expect(at("scan", "collect,iter")).toEqual(["ok:2", consumed]);
    expect(at("scan", "collect,collect")).toEqual(["ok:2", consumed]);
    expect(at("scan", "take,iter")).toEqual(["ok:1", chained]);
    // `db.query(t)` holds no state: each use is a new query.
    expect(at("init", "collect,collect")).toEqual(["ok:2", "ok:2"]);
  }, 120_000);
});
