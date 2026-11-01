// The batch-worker example end to end (STUDY-196 B-2): the component package installed from the workspace, three
// named workers draining their queues on the deployment's own scheduler, and the totals and statuses following live, the
// third paced by @bunvex/rate-limiter.
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

test("LLM requests go out in batches, each when the token budget allows it", async () => {
  type Request = { prompt: string; state: string; response: string | null };
  let requests: Request[] | undefined;
  d.client().onUpdate(api.rateLimited.listRequests, {}, (r) => {
    requests = r;
  });
  await until(() => requests !== undefined, "the first answer");
  // Six requests of 100 tokens: the first batch (five, 500 tokens) overdraws the 300-token budget by 200, which it
  // earns back at 60 tokens a second, so its call waits about 3.3 s. Without the budget it would go after the
  // second's debounce.
  const start = Date.now();
  const prompts = Array.from({ length: 6 }, (_, i) => `prompt ${i}`);
  await Promise.all(
    prompts.map((prompt) => d.http.mutation(api.rateLimited.submitRequest, { prompt, inputTokens: 100 })),
  );
  // Longer than `until` waits: the second batch waits for the budget too.
  while (requests?.filter((r) => r.state === "finished").length !== 6) {
    if (Date.now() - start > 60_000) throw new Error("timed out waiting for every request answered");
    await Bun.sleep(50);
  }
  expect(Date.now() - start).toBeGreaterThan(3_000);
  expect(requests!.map((r) => r.response).sort()).toEqual(prompts.map((p) => `Echo: ${p}`).sort());
}, 90_000);

test("the front end typechecks and builds", () => build(DIR), 120_000);
