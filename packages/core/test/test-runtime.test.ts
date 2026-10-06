// The runtime the engine reads its clock and sets its timers through (STUDY-132): the real one is the process's,
// the test one moves only when the test moves it, as Convex's test runtime.
import { describe, expect, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { realRuntime } from "../src/runtime.ts";
import { TestRuntime } from "../src/test-runtime.ts";

describe("TestRuntime", () => {
  test("time stands still until advanced; timers fire in order, each at its own instant", async () => {
    const rt = new TestRuntime({ now: 1_000_000 });
    const fired: [string, number, number][] = [];
    const log = (name: string) => () => fired.push([name, rt.monotonicNow(), rt.now()]);
    rt.setTimeout(log("b"), 20);
    rt.setTimeout(log("a"), 10);
    rt.setTimeout(log("c"), 20); // same instant as b: set after it, fires after it
    await Bun.sleep(30);
    expect(fired).toEqual([]);
    expect([rt.monotonicNow(), rt.now()]).toEqual([0, 1_000_000]);
    await rt.advance(15);
    expect(fired).toEqual([["a", 10, 1_000_010]]);
    expect(rt.monotonicNow()).toBe(15);
    await rt.advance(5);
    expect(fired.map((f) => f[0])).toEqual(["a", "b", "c"]);
    expect(rt.pending()).toBe(0);
  });

  test("a timer set by a timer fires in the same advance if it is due by then; what it starts settles first", async () => {
    const rt = new TestRuntime();
    const fired: number[] = [];
    rt.setTimeout(async () => {
      fired.push(rt.monotonicNow());
      await Promise.resolve();
      await Promise.resolve();
      rt.setTimeout(() => fired.push(rt.monotonicNow()), 5);
    }, 10);
    await rt.advance(20);
    expect(fired).toEqual([10, 15]);
  });

  test("an interval fires every period; cleared, from its own callback too, it stops", async () => {
    const rt = new TestRuntime();
    const at: number[] = [];
    const i = rt.setInterval(() => {
      at.push(rt.monotonicNow());
      if (at.length === 3) rt.clearInterval(i);
    }, 100);
    await rt.advance(1000);
    expect(at).toEqual([100, 200, 300]);
    const t = rt.setTimeout(() => at.push(-1), 10);
    rt.clearTimeout(t);
    await rt.advance(100);
    expect(at).toEqual([100, 200, 300]);
  });

  test("runUntilIdle: runs until only unref'd timers are left; a referenced interval never lets it end", async () => {
    const rt = new TestRuntime();
    const beats: number[] = [];
    rt.setInterval(() => beats.push(rt.monotonicNow()), 1000).unref(); // a heartbeat
    let done = false;
    void (async () => {
      await rt.sleep(2500);
      await rt.sleep(1000);
      done = true;
    })();
    await rt.runUntilIdle();
    expect(done).toBe(true);
    expect(rt.monotonicNow()).toBe(3500);
    expect(beats).toEqual([1000, 2000, 3000]); // it fired on the way, as time passed through it
    rt.setInterval(() => {}, 10);
    await expect(rt.runUntilIdle(50)).rejects.toThrow("still busy after 50 timers");
  });

  test("runUntilSettled: the time jumps to the next timer whenever the work has nothing else to do", async () => {
    const rt = new TestRuntime();
    const work = async () => {
      for (let i = 0; i < 5; i++) {
        await rt.sleep(20);
        // Work between the waits that takes real turns, not only microtasks.
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));
      }
      return rt.monotonicNow();
    };
    expect(await rt.runUntilSettled(work())).toBe(100);
    await expect(rt.runUntilSettled(Promise.reject(new Error("no")))).rejects.toThrow("no");
    await expect(rt.runUntilSettled(new Promise(() => {}), 5)).rejects.toThrow("still pending after 5 turns");
  });

  test("blockFor: the clock moves while the thread is busy; a timer that came due fires late, not early", async () => {
    const rt = new TestRuntime();
    const fired: number[] = [];
    rt.setTimeout(() => fired.push(rt.monotonicNow()), 10);
    rt.blockFor(25);
    expect(fired).toEqual([]);
    await rt.advance(0);
    expect(fired).toEqual([25]);
  });

  test("sleep: aborted, it rejects with the signal's reason and leaves no timer", async () => {
    const rt = new TestRuntime();
    const ac = new AbortController();
    const slept = rt.sleep(1000, ac.signal);
    ac.abort(new Error("stop"));
    await expect(slept).rejects.toThrow("stop");
    expect(rt.pending()).toBe(0);
    await expect(rt.sleep(10, ac.signal)).rejects.toThrow("stop");
  });

  test("a callback runs in the async context it was set in, as a real timer's", async () => {
    const rt = new TestRuntime();
    const als = new AsyncLocalStorage<string>();
    let seen: string | undefined = "none";
    als.run("request-1", () => rt.setTimeout(() => (seen = als.getStore()), 5));
    await rt.advance(5);
    expect(seen).toBe("request-1");
  });
});

describe("realRuntime", () => {
  test("the process's clocks and timers", async () => {
    expect(Math.abs(realRuntime.now() - Date.now())).toBeLessThan(50);
    const { monotonicNow } = realRuntime; // callable detached
    const t0 = monotonicNow();
    await realRuntime.sleep(5);
    expect(monotonicNow() - t0).toBeGreaterThanOrEqual(4);
    let fired = false;
    const t = realRuntime.setTimeout(() => (fired = true), 1);
    realRuntime.clearTimeout(t);
    await realRuntime.sleep(5);
    expect(fired).toBe(false);
    const ac = new AbortController();
    const slept = realRuntime.sleep(10_000, ac.signal);
    ac.abort(new Error("stop"));
    await expect(slept).rejects.toThrow("stop");
  });
});
