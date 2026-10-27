// Upstream's client tests (`src/client/index.test.ts` of get-convex/rate-limiter 0.4.2, STUDY-197 §1.7), ported:
// `RateLimiter` used from the functions of an app that installs the package by its name (fixtures/app), with a
// transactional limit and an asynchronous one drained by the batch worker on the virtual clock. Upstream builds its
// app with convex-test's `defineTestApp`, which `@bunvex/testing` has not (DV-546); the app is pushed instead.
//
// The error a limit throws is a `BunvexError` (Convex's `ConvexError`, DV-538).
// biome-ignore-all lint/suspicious/noExplicitAny: the app's api is untyped
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { anyApi } from "@bunvex/server";
import { bunvexTest, type TestBunvex } from "@bunvex/testing";
import { BunvexError } from "@bunvex/values";
import { isRateLimitError, type RateLimitError } from "../src/client/index.ts";

// Each test pushes its own deployment first, which takes longer than bun's 5 s default on a busy machine.
setDefaultTimeout(30_000);

const limits = (anyApi as any).limits;
const APP = join(import.meta.dir, "fixtures", "app");
const open: TestBunvex[] = [];
afterEach(async () => {
  for (const t of open.splice(0)) await t.close();
});
function deployment() {
  const t = bunvexTest({ cwd: APP });
  open.push(t);
  return t;
}
const drain = (t: TestBunvex) => t.finishAllScheduledFunctions(undefined, 1000);
const limitValue = async (t: TestBunvex, limit: string, key?: string) =>
  (await t.query(limits.value, { limit, key })).value as number;

test("isRateLimitError", () => {
  expect(isRateLimitError(new BunvexError({ kind: "RateLimited", name: "foo", retryAfter: 1 } as RateLimitError))).toBe(
    true,
  );
  expect(isRateLimitError(new BunvexError({ kind: "foo" }))).toBe(false);
});

describe("asynchronous", () => {
  test("limit and reset queue their writes instead of applying them", async () => {
    const t = deployment();
    for (let i = 0; i < 3; i++) expect(await t.mutation(limits.consume, { limit: "async" })).toEqual({ ok: true });
    // All three were allowed, and nothing is written yet.
    expect(await limitValue(t, "async")).toBe(3);
    await drain(t);
    expect(await limitValue(t, "async")).toBe(0);
    const blocked = await t.query(limits.check, { limit: "async" });
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfter).toBeGreaterThan(0);
    // `reset` of a named asynchronous limit is queued the same way.
    await t.mutation(limits.reset, { limit: "async" });
    await drain(t);
    expect((await t.query(limits.check, { limit: "async" })).ok).toBe(true);
  });

  test("rejected asynchronous calls consume nothing", async () => {
    const t = deployment();
    // Each call reads the stale value 3, so all four get through, and the limit overshoots once the worker runs.
    for (let i = 0; i < 4; i++) await t.mutation(limits.consume, { limit: "async" });
    await drain(t);
    const before = await limitValue(t, "async");
    expect(before).toBeLessThan(0);
    expect((await t.mutation(limits.consume, { limit: "async" })).ok).toBe(false);
    await drain(t);
    expect(await limitValue(t, "async")).toBe(before);
  });

  test("reserve lets an asynchronous limit go into debt", async () => {
    const t = deployment();
    // 5 against a capacity of 3: allowed only because of `reserve`.
    const reserved = await t.mutation(limits.consume, { limit: "async", count: 5, reserve: true });
    expect(reserved.ok).toBe(true);
    expect(reserved.retryAfter).toBeGreaterThan(0);
    await drain(t);
    expect(await limitValue(t, "async")).toBe(-2);
  });

  test("throws a RateLimitError when `throws` is true", async () => {
    const t = deployment();
    for (let i = 0; i < 3; i++) await t.mutation(limits.consume, { limit: "async", throws: true });
    await drain(t);
    const error = await t.mutation(limits.consume, { limit: "async", throws: true }).catch((e: unknown) => e);
    expect(isRateLimitError(error)).toBe(true);
    expect((error as BunvexError<RateLimitError>).data).toMatchObject({ kind: "RateLimited", name: "async" });
  });

  test("limit and reset honor `applyUpdates` from an inline config", async () => {
    const t = deployment();
    expect((await t.mutation(limits.inlineAsync, { count: 60 })).ok).toBe(true);
    await drain(t);
    expect((await t.mutation(limits.inlineAsync, { count: 60 })).ok).toBe(false);
    await t.mutation(limits.resetInlineAsync, {});
    await drain(t);
    expect((await t.mutation(limits.inlineAsync, { count: 60 })).ok).toBe(true);
  });

  test("hookAPI resolves its configured key against an asynchronous limit", async () => {
    const t = deployment();
    expect((await t.query(limits.getRateLimit, {})).value).toBe(3);
    for (let i = 0; i < 2; i++) await t.mutation(limits.consume, { limit: "async", key: "u" });
    await drain(t);
    const data = await t.query(limits.getRateLimit, {});
    expect(data.value).toBe(1);
    expect(data.shard).toBe(0);
    expect(data.config.shards).toBe(1);
  });
});

describe("transactional", () => {
  test("limit consumes the rate limit", async () => {
    const t = deployment();
    for (let i = 0; i < 3; i++) expect((await t.mutation(limits.consume, { limit: "strict" })).ok).toBe(true);
    expect(await limitValue(t, "strict")).toBe(0);
    expect((await t.mutation(limits.consume, { limit: "strict" })).ok).toBe(false);
  });
});

describe("the client's own errors", () => {
  test("an asynchronous config with shards", async () => {
    const t = deployment();
    await expect(t.mutation(limits.badInline, {})).rejects.toThrow(
      "Rate limit badInline applies updates asynchronously and can't be sharded.",
    );
  });

  test("the app's own `isRateLimitError` on the error the component throws", async () => {
    const t = deployment();
    expect(await t.mutation(limits.consumeAndCatch, {})).toEqual({
      isRateLimitError: true,
      data: { kind: "RateLimited", name: "strict", retryAfter: 6 * 60 * 1000 },
    });
  });
});
