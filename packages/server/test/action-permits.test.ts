// The action limiter (STUDY-31): never more than `max` at once, a freed permit goes to the first waiter,
// and a wait past the timeout is Convex's TooManyConcurrentRequests.
import { describe, expect, test } from "bun:test";
import { defineSchema, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { ActionPermits, TooManyConcurrentRequestsError } from "../src/action-permits.ts";
import { action, Functions } from "../src/functions.ts";
import { createServer } from "../src/server.ts";

describe("ActionPermits", () => {
  test("at most `max` run at once, even with newcomers arriving as permits are freed", async () => {
    const p = new ActionPermits(3, 5000);
    let running = 0;
    let peak = 0;
    const work = () =>
      p.run(async () => {
        running++;
        peak = Math.max(peak, running);
        await Bun.sleep(1 + Math.random() * 5);
        running--;
      });
    const all: Promise<void>[] = [];
    for (let i = 0; i < 60; i++) {
      all.push(work());
      if (i % 7 === 0) await Bun.sleep(1);
    }
    await Promise.all(all);
    expect(peak).toBe(3);
    expect(p.stats.peak).toBe(3);
  });

  test("a wait past the timeout fails with Convex's error", async () => {
    const p = new ActionPermits(1, 30);
    const hold = p.run(() => Bun.sleep(100));
    const e = await p.run(async () => {}).catch((x) => x);
    expect(e).toBeInstanceOf(TooManyConcurrentRequestsError);
    expect((e as Error).message).toBe(
      "Too many concurrent requests. Your backend is limited to 1 concurrent actions. To raise the limit, set APPLICATION_MAX_CONCURRENT_V8_ACTIONS.",
    );
    await hold;
  });

  test("the HTTP API's /api/action answers 429 too", async () => {
    const engine = await new Engine(defineSchema({}), await MemoryPersistence.open(null, { durable: false })).init();
    const functions = new Functions(engine, { actionPermits: new ActionPermits(1, 30) }).register("m", {
      slow: action(async () => {
        await Bun.sleep(150);
        return 1;
      }),
    });
    const server = createServer({ engine, functions, port: 0 });
    try {
      const call = () =>
        fetch(`http://127.0.0.1:${server.server.port}/api/action`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: "m:slow", args: {} }),
        });
      const first = call();
      await Bun.sleep(20);
      const second = await call();
      expect(second.status).toBe(429);
      expect(((await second.json()) as { code: string }).code).toBe("TooManyConcurrentRequests");
      expect((await first).status).toBe(200);
    } finally {
      server.stop();
    }
  });
});
