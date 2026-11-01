// The work pool (STUDY-199) on Convex's backend (the oracle) with `@convex-dev/workpool` 0.4.14, and on bunvex's with
// `@bunvex/workpool`: the same app (workpool-app/) enqueues the same jobs on both and records every `onComplete`. It
// compares:
// - each job's status right after its enqueue, and once it settled;
// - each `onComplete`'s `context` and `result`: success values, the `failed.error` text of an action, a mutation and
//   a query that throw, a `NonRetryableError`, retries that end in success or run out, a cancelation before the
//   start, and `onCompleteExcludeKinds`;
// - the client's and the component's refusals, word for word (their frames are inside each package's own code);
// - the component's tables once the pool settled (counts only).
// Retry delays are random on each side, so only outcomes are compared. Local only: skipped, with a note, when
// Convex's backend is not there.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Backend, ORACLE_BIN, startBunvex, startConvex } from "../harness/backends.ts";

const ready = existsSync(ORACLE_BIN);
if (!ready) console.warn(`workpool: skipped, no Convex backend at ${ORACLE_BIN} (set CONVEX_BACKEND_BIN)`);

const APP = resolve(import.meta.dir, "../workpool-app");
let convex: Backend;
let bunvex: Backend;

/** bunvex's project installs `@bunvex/workpool` where Convex's has `@convex-dev/workpool`. */
function prepare(project: string, dir: "convex" | "bunvex") {
  if (dir !== "bunvex") return;
  const functions = join(project, dir);
  renameSync(join(functions, "convex.config.ts"), join(functions, "bunvex.config.ts"));
  for (const name of ["bunvex.config.ts", "work.ts"]) {
    const file = join(functions, name);
    writeFileSync(
      file,
      readFileSync(file, "utf8")
        .replaceAll('"@convex-dev/workpool/convex.config"', '"@bunvex/workpool/bunvex.config.js"')
        .replaceAll('"@convex-dev/workpool"', '"@bunvex/workpool"'),
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

const value = async (b: Backend, kind: "query" | "mutation", path: string, args: Record<string, unknown>) => {
  const r = await b.call(kind, path, args);
  if (!r.ok) throw new Error(`${b.name}: call failed: ${JSON.stringify(r.body)}`);
  return (r.body as { value: unknown }).value;
};

/**
 * A frame of the app as both name it: the functions' directory (DV-03), no function name (DV-345), no position
 * (DV-346), as error-frames.test.ts compares them.
 */
const normalized = (x: unknown) =>
  JSON.parse(
    JSON.stringify(x)
      .replaceAll("../convex/", "../<functions>/")
      .replaceAll("../bunvex/", "../<functions>/")
      .replace(/ {4}at (async )?[^ (]+ \((\.\.\/<functions>\/[^):]*):\d+:\d+\)/g, "    at $1<fn> ($2:N:N)"),
  );
/** A refusal's message without its frames: they are inside each package's own code. */
const messageOnly = (x: Record<string, string>) =>
  Object.fromEntries(Object.entries(x).map(([k, m]) => [k, m.split("\n    at ")[0]]));

type Job = { label: string; kind: "action" | "mutation" | "query" } & Record<string, unknown>;
const JOBS: Job[] = [
  { label: "a-ok", kind: "action" },
  { label: "m-ok", kind: "mutation" },
  { label: "q-ok", kind: "query" },
  { label: "a-fail", kind: "action", fail: true },
  { label: "m-fail", kind: "mutation", fail: true },
  { label: "q-fail", kind: "query", fail: true },
  {
    label: "a-nonretryable",
    kind: "action",
    nonRetryable: true,
    retry: { maxAttempts: 3, initialBackoffMs: 10, base: 1 },
  },
  { label: "a-retry-ok", kind: "action", failTimes: 2, retry: { maxAttempts: 5, initialBackoffMs: 10, base: 1 } },
  { label: "a-retry-out", kind: "action", failTimes: 9, retry: { maxAttempts: 2, initialBackoffMs: 10, base: 1 } },
  { label: "a-exclude-success", kind: "action", excludeKinds: ["success"] },
  { label: "a-exclude-failed", kind: "action", fail: true, excludeKinds: ["failed"] },
];
/** Jobs whose `onComplete` is expected (not excluded). */
const CALLED = JOBS.filter((j) => !j.label.startsWith("a-exclude")).length + 1; // + the canceled one

async function run(b: Backend) {
  const enqueued: Record<string, unknown> = {};
  const ids: Record<string, string> = {};
  for (const job of JOBS) {
    const r = (await value(b, "mutation", "work:enqueue", job)) as { id: string; status: unknown };
    ids[job.label] = r.id;
    enqueued[job.label] = r.status;
  }
  // Canceled before its start: a minute ahead.
  const later = (await value(b, "mutation", "work:enqueue", {
    kind: "action",
    label: "a-canceled",
    runAfter: 60_000,
  })) as {
    id: string;
    status: unknown;
  };
  ids["a-canceled"] = later.id;
  enqueued["a-canceled"] = later.status;
  const canceledStatus = await value(b, "mutation", "work:cancel", { id: later.id });

  const deadline = Date.now() + 60_000;
  let completions: unknown[] = [];
  while (Date.now() < deadline) {
    completions = (await value(b, "query", "work:completions", {})) as unknown[];
    if (completions.length >= CALLED) break;
    await Bun.sleep(200);
  }
  // A beat more, so that an excluded callback that ran anyway would be seen.
  await Bun.sleep(1_000);
  completions = (await value(b, "query", "work:completions", {})) as unknown[];
  const settled: Record<string, unknown> = {};
  for (const [label, id] of Object.entries(ids)) settled[label] = await value(b, "query", "work:status", { id });
  return normalized({ enqueued, canceledStatus, completions, settled });
}

describe.skipIf(!ready)("the work pool: Convex with @convex-dev/workpool 0.4.14, bunvex with ours", () => {
  test("statuses, every onComplete's context and result, and the failed texts", async () => {
    const [c, x] = await Promise.all([run(convex), run(bunvex)]);
    expect(x).toEqual(c);
  }, 120_000);

  test("the client's and the component's refusals, word for word", async () => {
    const [c, x] = [
      await value(convex, "mutation", "work:refusals", {}),
      await value(bunvex, "mutation", "work:refusals", {}),
    ];
    expect(messageOnly(x as Record<string, string>)).toEqual(messageOnly(c as Record<string, string>));
  });
});
