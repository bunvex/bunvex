// The sharded-counter example end to end (STUDY-183 S-4): the component package installed from the workspace and
// mounted twice, its client used from the app's functions, a trigger counting a table, and the checkboxes' count
// following the clicks live.
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

/** Run an internal function as an admin does (`bunvex run`): its printed result, parsed. */
const run = async (path: string) => JSON.parse((await d.cli("run", path)).trim() || "null");

test("checking and unchecking boxes counts them, live", async () => {
  let count: number | undefined;
  d.client().onUpdate(api.checkboxes.countCheckedBoxes, {}, (n) => {
    count = n;
  });
  await until(() => count === 0, "the first count");
  const toggle = (documentIdx: number, arrayIdx: number, checked: boolean) =>
    d.http.mutation(api.checkboxes.toggle, { documentIdx, arrayIdx, checked });
  await toggle(0, 0, true);
  await toggle(0, 1, true);
  await toggle(249, 3999, true);
  await until(() => count === 3, "three boxes checked");
  // A box already checked writes nothing and counts nothing.
  await toggle(0, 0, true);
  await toggle(0, 0, false);
  await until(() => count === 2, "one box unchecked");
  const bytes = (await d.http.query(api.checkboxes.get, { documentIdx: 0 })) as ArrayBuffer;
  expect([...new Uint8Array(bytes).slice(0, 1)]).toEqual([0b10]);
  expect(await d.http.query(api.checkboxes.get, { documentIdx: 1 })).toBeNull();
  await expect(toggle(250, 0, true)).rejects.toThrow("documentIdx out of range");
});

test("the users counter: for(), the trigger, rebalance, the estimate and reset", async () => {
  await d.http.mutation(api.example.addOne, {});
  await d.http.mutation(api.example.insertUserWithTrigger, {});
  await d.http.mutation(api.example.insertUserWithTrigger, {});
  expect(await d.http.query(api.example.getCount, {})).toBe(3);
  await d.http.mutation(api.example.rebalanceUsers, {});
  // Spread over the users' 3 shards: one read shard, scaled by 3, is the count.
  expect(await d.http.query(api.example.estimateUserCount, {})).toBeCloseTo(3);
  await d.http.mutation(api.example.resetUsers, {});
  expect(await d.http.query(api.example.getCount, {})).toBe(0);
});

test("the client, the component's functions called directly, and the remembered shard", async () => {
  expect(await run("example:usingClient")).toBe(2);
  expect(await run("example:usingFunctions")).toBe(1);
  expect(await run("example:directCall")).toBe(5);
  // 100 adds through one instance land on one shard of 10.
  await run("example:testStickyShards");
  // The component's functions as the CLI runs them, in each mount.
  expect(JSON.parse(await d.cli("run", "--component", "shardedCounter", "public:count", '{"name":"beans"}'))).toBe(100);
  expect(
    JSON.parse(await d.cli("run", "--component", "checkboxCounter", "public:count", '{"name":"checkboxes"}')),
  ).toBe(2);
});

test("backfilling users written before the counting started", async () => {
  await d.http.mutation(api.example.resetUsers, {});
  for (let i = 0; i < 4; i++) await run("example:insertUserBeforeBackfill");
  // Without a cursor row, the backfill has nothing to do.
  await run("example:backfillUsers");
  expect(await d.http.query(api.example.getCount, {})).toBe(0);
  await run("example:insertUserDuringBackfill");
  expect(await d.http.query(api.example.getCount, {})).toBe(1);
});

test("the front end typechecks and builds", () => build(DIR), 120_000);
