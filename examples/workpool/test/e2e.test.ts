// The workpool example end to end: the component installed from the workspace and mounted as three pools; each keeps
// to its limit, retries as configured, records every job's end through its callback, and cancels what has not
// started. The front end typechecks and builds.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import { build, type Deployment, deploy } from "bunvex-examples-harness";
import { api } from "../bunvex/_generated/api.js";

const DIR = resolve(import.meta.dir, "..");
let d: Deployment;
beforeAll(async () => {
  d = await deploy(DIR);
});
afterAll(() => d?.stop());

type Row = { state: string; attempts: number; startedAt: number | null; finishedAt: number | null };
const ENDED = ["succeeded", "failed", "canceled"];

/** The pool's jobs once every one has ended (waiting by the clock: jobs take up to a second each). */
async function settled(pool: "big" | "small" | "serial", count: number, ms = 60_000): Promise<Row[]> {
  const deadline = Date.now() + ms;
  for (;;) {
    const rows = (await d.http.query(api.tasks.timeline, { pool })) as Row[];
    if (rows.length === count && rows.every((r) => ENDED.includes(r.state))) return rows;
    if (Date.now() > deadline) throw new Error(`${pool}: not settled: ${JSON.stringify(rows)}`);
    await Bun.sleep(100);
  }
}

test("the serial pool runs one job at a time, and every job's callback records its success", async () => {
  await d.http.mutation(api.tasks.start, { pool: "serial", count: 4, failRate: 0 });
  const rows = await settled("serial", 4);
  expect(rows.map((r) => r.state)).toEqual(["succeeded", "succeeded", "succeeded", "succeeded"]);
  // Never two at once: each job starts after the one before it ended.
  const spans = rows.map((r) => [r.startedAt!, r.finishedAt!] as const).sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < spans.length; i++) expect(spans[i]![0]).toBeGreaterThanOrEqual(spans[i - 1]![1] - 50);
}, 90_000);

test("the big pool retries a failing action three times; the small pool gives up at once", async () => {
  await d.http.mutation(api.tasks.start, { pool: "big", count: 3, failRate: 1 });
  await d.http.mutation(api.tasks.start, { pool: "small", count: 3, failRate: 1 });
  const big = await settled("big", 3);
  const small = await settled("small", 3);
  expect(big.map((r) => [r.state, r.attempts])).toEqual([
    ["failed", 3],
    ["failed", 3],
    ["failed", 3],
  ]);
  expect(small.map((r) => [r.state, r.attempts])).toEqual([
    ["failed", 1],
    ["failed", 1],
    ["failed", 1],
  ]);
}, 90_000);

test("canceling the rest: jobs not started yet never run, and their callbacks record the cancelation", async () => {
  const before = ((await d.http.query(api.tasks.timeline, { pool: "small" })) as Row[]).length;
  await d.http.mutation(api.tasks.start, { pool: "small", count: 10, failRate: 0 });
  await d.http.mutation(api.tasks.cancelAll, { pool: "small" });
  const rows = (await settled("small", before + 10)).slice(before);
  const canceled = rows.filter((r) => r.state === "canceled");
  // At most the pool's 3 could have started before the cancelation; the rest never ran.
  expect(canceled.length).toBeGreaterThanOrEqual(7);
  for (const r of canceled) expect(r.attempts).toBe(0);
}, 90_000);

test("the front end typechecks and builds", () => build(DIR), 120_000);
