// The batch-worker example end to end (STUDY-196 B-2): the component package installed from the workspace, two
// named workers draining their queues on the deployment's own scheduler, and the totals and statuses following live.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import { build, type Deployment, deploy, until } from "bunvex-examples-harness";
import { api } from "../bunvex/_generated/api.js";

const DIR = resolve(import.meta.dir, "..");
let d: Deployment;
beforeAll(async () => {
  d = await deploy(DIR);
});
afterAll(() => d?.stop());

test("the work queue sums every event in batches, then goes idle", async () => {
  let totals: { total: number; count: number; pending: number } | undefined;
  let status: { kind: string } | null | undefined;
  d.client().onUpdate(api.example.getTotals, {}, (t) => {
    totals = t;
  });
  d.client().onUpdate(api.example.workerStatus, {}, (s) => {
    status = s;
  });
  await until(() => totals?.count === 0 && status === null, "an empty queue, never run");

  await Promise.all(Array.from({ length: 25 }, (_, i) => d.http.mutation(api.example.addEvent, { value: i + 1 })));

  await until(() => totals?.count === 25 && totals.pending === 0, "every event processed");
  expect(totals!.total).toBe((25 * 26) / 2);
  // After the cooldown (2 s of polling), the loop goes idle until the next ping.
  await until(() => status?.kind === "idle", "the worker idle");
});

test("the scoreboard folds every score into its team's total", async () => {
  let data: { totals: Record<string, number>; pending: number } | undefined;
  d.client().onUpdate(api.aggregates.getTotals, {}, (t) => {
    data = t;
  });
  const scores = Array.from({ length: 60 }, (_, i) => ({
    team: ["Red", "Blue", "Green"][i % 3]!,
    points: (i % 5) + 1,
  }));
  await Promise.all(scores.map((s) => d.http.mutation(api.aggregates.recordScore, s)));

  const expected: Record<string, number> = {};
  for (const { team, points } of scores) expected[team] = (expected[team] ?? 0) + points;
  await until(
    () => data?.pending === 0 && Object.entries(expected).every(([team, total]) => data?.totals[team] === total),
    "every score folded in",
  );
  expect(data!.totals).toEqual(expected);
});

test("the front end typechecks and builds", () => build(DIR), 120_000);
