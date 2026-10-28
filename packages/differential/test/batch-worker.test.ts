// The batch worker (STUDY-196) on Convex's backend (the oracle) with `@convex-dev/batch-worker` 0.3.6, and on
// bunvex's with `@bunvex/batch-worker`: the same app (batch-worker-app/) enqueues the same work on both, each
// backend's scheduler runs the loop in real time, and once both workers are idle the test compares what an app sees:
// - the batches the worker mutation got, in order, and what is left in the queue;
// - the status and the cursor of each worker (a commit-timestamp-shaped `int64` cursor for the marks);
// - the component's two tables, read with each CLI's `run --component … --inline-query`: their fields, the stored
//   config and status, and the cursor (generations and times depend on how many polls each backend's clock allowed);
// - the errors of bad arguments, word for word.
// Local only: skipped, with a note, when Convex's backend is not there (scripts/download-convex-backend.sh, or
// CONVEX_BACKEND_BIN).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Backend, ORACLE_BIN, startBunvex, startConvex } from "../harness/backends.ts";

const ready = existsSync(ORACLE_BIN);
if (!ready) console.warn(`batch-worker: skipped, no Convex backend at ${ORACLE_BIN} (set CONVEX_BACKEND_BIN)`);

const APP = resolve(import.meta.dir, "../batch-worker-app");
let convex: Backend;
let bunvex: Backend;

/** bunvex's project installs `@bunvex/batch-worker` where Convex's has `@convex-dev/batch-worker`. */
function prepare(project: string, dir: "convex" | "bunvex") {
  if (dir !== "bunvex") return;
  const functions = join(project, dir);
  renameSync(join(functions, "convex.config.ts"), join(functions, "bunvex.config.ts"));
  for (const name of ["bunvex.config.ts", "worker.ts"]) {
    const file = join(functions, name);
    writeFileSync(
      file,
      readFileSync(file, "utf8")
        .replaceAll('"@convex-dev/batch-worker/convex.config"', '"@bunvex/batch-worker/bunvex.config.js"')
        .replaceAll('"@convex-dev/batch-worker"', '"@bunvex/batch-worker"'),
    );
  }
}

beforeAll(async () => {
  if (!ready) return;
  [convex, bunvex] = await Promise.all([startConvex({ app: APP, prepare }), startBunvex({ app: APP, prepare })]);
}, 300_000);

afterAll(async () => {
  await Promise.all([convex?.stop(), bunvex?.stop()]);
});

const value = (b: Backend, r: { ok: boolean; body: unknown }) => {
  if (!r.ok) throw new Error(`${b.name}: call failed: ${JSON.stringify(r.body)}`);
  return (r.body as { value: unknown }).value;
};
const both = async (kind: "query" | "mutation", path: string, args: Record<string, unknown>) => {
  const out: unknown[] = [];
  for (const b of [convex, bunvex]) out.push(value(b, await b.call(kind, path, args)));
  return out as [unknown, unknown];
};

type State = { items: number; status: Record<string, { kind: string } | null> };
/** The app's view on one backend, once its workers are idle (or after 30 s, to fail with what is there). */
async function settled(b: Backend): Promise<unknown> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const s = value(b, await b.call("query", "worker:state", {})) as State;
    const idle = Object.values(s.status).every((x) => x === null || x.kind === "idle");
    if ((idle && s.items === 0) || Date.now() > deadline) return s;
    await Bun.sleep(100);
  }
}

/** The component's two tables on one backend, read by its CLI in the component: what does not depend on timing. */
async function tables(b: Backend): Promise<unknown> {
  const query = `
    const workers = (await ctx.db.query("workers").collect()).map((w) => ({
      keys: Object.keys(w).sort(), name: w.name, config: w.config, status: w.status,
      handles: [typeof w.workQuery, typeof w.workerMutation],
    }));
    const states = (await ctx.db.query("workerState").collect()).map((s) => ({
      keys: Object.keys(s).sort(), generation: typeof s.generation, cursor: s.cursor === undefined ? "none" : String(s.cursor),
    }));
    return JSON.stringify({ workers: workers.sort((a, b) => (a.name < b.name ? -1 : 1)), states: states.sort((a, b) => (a.cursor < b.cursor ? -1 : 1)) });`;
  const out = await b.cli(["run", "--component", "batchWorker", "--inline-query", query]);
  return JSON.parse(JSON.parse(out.trim()) as string);
}

describe.skipIf(!ready)("the batch worker: Convex with @convex-dev/batch-worker 0.3.6, bunvex with ours", () => {
  test("a queue and a cursor-driven worker drain to the same batches, status, cursor and component rows", async () => {
    await both("mutation", "worker:enqueue", { values: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] });
    await both("mutation", "worker:enqueueMarks", { seqs: [0, 1, 2, 3, 4] });
    const [c, x] = [await settled(convex), await settled(bunvex)];
    expect(x).toEqual(c);
    expect((c as State).items).toBe(0);
    expect(await tables(bunvex)).toEqual(await tables(convex));
  }, 60_000);

  test("the component's functions with bad arguments: the same errors", async () => {
    const cases: [string, unknown][] = [
      ["setCursor", { name: "ghost", cursor: 1 }],
      ["status", { name: 1 }],
      ["ping", { name: "x" }],
      ["ping", { name: "x", workQuery: "q", workerMutation: "m", config: { debounceMs: "0" } }],
      ["start", {}],
      ["kick", { name: "ghost" }],
      ["getCursor", { name: "ghost" }],
    ];
    const results: { convex: unknown[]; bunvex: unknown[] } = { convex: [], bunvex: [] };
    for (const [fn, args] of cases) {
      const [c, x] = await both("mutation", "worker:call", { fn, args });
      results.convex.push({ fn, result: c });
      results.bunvex.push({ fn, result: x });
    }
    expect(results.bunvex).toEqual(results.convex);
  });
});
