// The rate-limiter example end to end (STUDY-197 L-1): the component package installed from the workspace, the
// API walk-through, the playground's limit, the hook's query, and the front end's build.
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

const run = async (fn: string, args: Record<string, unknown> = {}) =>
  JSON.parse(await d.cli("run", fn, JSON.stringify(args)));

test("three messages pass, the fourth throws a rate limit error, and check agrees", async () => {
  expect(await run("example:sendMessages", { key: "ada" })).toEqual({
    kind: "RateLimited",
    name: "sendMessage",
    retryAfter: expect.any(Number),
  });
  expect(await run("example:check", { key: "ada" })).toMatchObject({ ok: false });
  // Another key has its own tokens.
  expect(await run("example:check", { key: "grace" })).toEqual({ ok: true });
});

test("an inline config and the component's own functions: limit, check, reset", async () => {
  expect(await run("example:inlineConfig")).toBe("ok");
  expect(await run("example:direct")).toBe("ok");
});

test("the playground spends, refuses with a retry time, reserves, and resets", async () => {
  const config = { kind: "token bucket" as const, rate: 1, period: 60_000, capacity: 2 };
  const spend = (count: number, reserve = false) =>
    d.http.mutation(api.playground.consumeRateLimit, { config, count, reserve });
  expect(await spend(2)).toEqual({ ok: true });
  const refused = await spend(1);
  expect(refused.ok).toBe(false);
  expect(refused.retryAfter).toBeGreaterThan(50_000);
  const reserved = await spend(1, true);
  expect(reserved.ok).toBe(true);
  expect(reserved.retryAfter).toBeGreaterThan(50_000);
  await d.http.mutation(api.playground.resetRateLimit, {});
  expect(await spend(2)).toEqual({ ok: true });
});

test("the hook's query follows the tokens live; the server's time is near the test's", async () => {
  let value: { value: number; ts: number } | undefined;
  d.client().onUpdate(api.example.getRateLimit, {}, (v) => {
    value = v;
  });
  await until(() => value !== undefined, "the limit's value");
  const before = value!.value;
  await d.http.mutation(api.example.consumeTokens, { count: 4 });
  await until(() => value !== undefined && value.value < before, "the spent tokens");
  expect(value!.value).toBeCloseTo(before - 4, 0);
  const serverTime = await d.http.mutation(api.example.getServerTime, {});
  expect(Math.abs(serverTime - Date.now())).toBeLessThan(5_000);
});

test("the load test: a sharded limit lets through about its rate, and refuses the rest", async () => {
  // 20 calls a second over 10 shards of 2 tokens: a 1 s period. Asked 50 % more, for 3 s.
  const r = await run("loadTest:run", { qps: 20, shards: 10, shardCapacity: 2, overRequest: 1.5, duration: 3_000 });
  expect(r.config).toMatchObject({ rate: 20, period: 1_000, shards: 10 });
  expect(r.limited).toBeGreaterThan(0);
  expect(r.perSecond.passed).toBeGreaterThan(10);
  expect(r.perSecond.passed).toBeLessThan(30);
}, 60_000);

test("the front end typechecks and builds", () => build(DIR), 120_000);
