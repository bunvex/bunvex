// The action limiter (STUDY-31): never more than `max` at once, a freed permit goes to the first waiter,
// and a wait past the timeout is Convex's TooManyConcurrentRequests.
import { describe, expect, test } from "bun:test";
import { defineSchema, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { TestRuntime } from "@bunvex/core/test-runtime";
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
    const rt = new TestRuntime();
    const p = new ActionPermits(1, 30, rt);
    const hold = p.run(() => rt.sleep(100));
    const waiter = p.run(async () => {}).catch((x) => x);
    await Bun.sleep(50); // real time does not count: only the runtime's
    await rt.advance(29);
    expect(p.outstanding.queued).toBe(1); // still waiting
    await rt.advance(1);
    const e = await waiter;
    expect(e).toBeInstanceOf(TooManyConcurrentRequestsError);
    expect((e as Error).message).toBe(
      "Too many concurrent requests. Your backend is limited to 1 concurrent actions. To raise the limit, set APPLICATION_MAX_CONCURRENT_V8_ACTIONS.",
    );
    await rt.advance(70);
    await hold;
  });

  test("the HTTP API's /api/action answers 429 too", async () => {
    const engine = await new Engine(defineSchema({}), await MemoryPersistence.open(null, { durable: false })).init();
    const rt = new TestRuntime();
    const permits = new ActionPermits(1, 30, rt);
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    const functions = new Functions(engine, { actionPermits: permits }).register("m", {
      slow: action(async () => {
        await released;
        return 1;
      }),
    });
    /** The HTTP requests are real: wait for the state they lead to. */
    const until = async (f: () => boolean) => {
      for (let i = 0; i < 2000 && !f(); i++) await Bun.sleep(1);
      expect(f()).toBe(true);
    };
    const server = createServer({ engine, functions, port: 0 });
    try {
      const call = () =>
        fetch(`http://127.0.0.1:${server.server.port}/api/action`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: "m:slow", args: {} }),
        });
      const first = call();
      await until(() => permits.outstanding.running === 1);
      const refused = call();
      await until(() => permits.outstanding.queued === 1);
      await rt.advance(30);
      const second = await refused;
      expect(second.status).toBe(429);
      expect(((await second.json()) as { code: string }).code).toBe("TooManyConcurrentRequests");
      release();
      expect((await first).status).toBe(200);
    } finally {
      server.stop();
    }
  });
});
