// The execution workers' runtime (STUDY-194 §4.12, §4.13): started lazily up to the cap, a call to the least busy
// ready worker, none ready → in-thread (null); a worker that ends or never yields is replaced and its calls fail;
// a worker that cannot start is retried later; close ends them all.
import { afterEach, describe, expect, test } from "bun:test";
import {
  EXECUTION_WORKER_ENTRY,
  ExecutionWorkerError,
  ExecutionWorkers,
  type ExecutionWorkersOptions,
  maxExecutionWorkers,
} from "../src/execution-workers.ts";

const ENTRY = new URL("./fixtures/execution-test-worker.ts", import.meta.url).href;

const pools: ExecutionWorkers[] = [];
afterEach(async () => {
  await Promise.all(pools.splice(0).map((p) => p.close()));
});

function pool(o: Partial<ExecutionWorkersOptions> = {}) {
  const lines: string[] = [];
  const p = new ExecutionWorkers({ max: 2, entry: ENTRY, init: () => "", log: (l) => lines.push(l), ...o });
  pools.push(p);
  return { p, lines };
}

async function until(what: () => boolean, ms = 5000) {
  const end = performance.now() + ms;
  while (!what()) {
    if (performance.now() > end) throw new Error("timed out waiting");
    await Bun.sleep(5);
  }
}

/** A call that must be dispatched (some worker is ready). */
function sent(p: ExecutionWorkers, text: string, timeoutMs = 1000): Promise<string> {
  const r = p.call(text, timeoutMs);
  if (!r) throw new Error("no worker was ready");
  return r;
}

describe("execution workers", () => {
  test("MAX_ISOLATE_WORKERS: the core count by default, 0 allowed", () => {
    expect(maxExecutionWorkers({})).toBe(navigator.hardwareConcurrency);
    expect(maxExecutionWorkers({ MAX_ISOLATE_WORKERS: "3" })).toBe(3);
    expect(maxExecutionWorkers({ MAX_ISOLATE_WORKERS: "0" })).toBe(0);
  });

  test("lazily: the first call runs in-thread and starts one; another starts only when every ready one is busy", async () => {
    const { p } = pool({ max: 2 });
    expect(p.size).toBe(0);
    expect(p.call("echo:a", 1000)).toBeNull();
    expect(p.size).toBe(1);
    // While it starts, no second one.
    expect(p.call("echo:a", 1000)).toBeNull();
    expect(p.size).toBe(1);
    await until(() => p.ready === 1);
    // An idle worker takes the call: no second one.
    expect(await sent(p, "echo:hello")).toBe("hello");
    expect(p.size).toBe(1);
    // A busy one: the call still goes to it, and a second starts.
    const waiting = sent(p, "wait:100");
    const other = sent(p, "echo:b");
    expect(p.size).toBe(2);
    expect(await Promise.all([waiting, other])).toEqual(["waited", "b"]);
    await until(() => p.ready === 2);
    // Never past the cap.
    const busy = [sent(p, "wait:50"), sent(p, "wait:50"), sent(p, "wait:50")];
    expect(p.size).toBe(2);
    await Promise.all(busy);
    expect(p.counts.started).toBe(2);
  });

  test("a call goes to the ready worker with the fewest calls in flight", async () => {
    const { p } = pool({ max: 2 });
    p.call("echo:x", 1000);
    await until(() => p.ready === 1);
    const a = sent(p, "wait:300");
    // The only ready worker is busy: this call goes to it, and a second worker starts.
    const first = await sent(p, "whoami");
    await until(() => p.ready === 2);
    // The first still has a call in flight, the second none.
    const second = await sent(p, "whoami");
    expect(second).not.toBe(first);
    await a;
  });

  test("the worker module bunvex ships starts", async () => {
    const { p } = pool({ max: 1, entry: EXECUTION_WORKER_ENTRY });
    expect(p.call("x", 1000)).toBeNull();
    await until(() => p.ready === 1);
    expect(p.counts.failedStarts).toBe(0);
  });

  test("0: no worker ever starts", () => {
    const { p } = pool({ max: 0 });
    expect(p.call("echo:a", 1000)).toBeNull();
    expect(p.size).toBe(0);
  });

  for (const how of ["exit", "throw"] as const) {
    test(`a worker that ends (${how}) fails its calls as system errors; the next call starts another`, async () => {
      const { p, lines } = pool({ max: 1 });
      p.call("echo:x", 1000);
      await until(() => p.ready === 1);
      const other = sent(p, "wait:1000");
      const dying = sent(p, how);
      for (const call of [dying, other]) {
        const e = await call.catch((e) => e);
        expect(e).toBeInstanceOf(ExecutionWorkerError);
        expect((e as ExecutionWorkerError).reason).toBe("died");
        expect((e as Error).message).toMatch(/^the execution worker running this call ended \(exit code \d+/);
      }
      expect(p.size).toBe(0);
      expect(p.counts.died).toBe(1);
      expect(lines.some((l) => l.startsWith("An execution worker ended"))).toBe(true);
      expect(p.call("echo:again", 1000)).toBeNull();
      await until(() => p.ready === 1);
      expect(await sent(p, "echo:again")).toBe("again");
    });
  }

  test("a call the worker itself fails is a system error, and the worker stays", async () => {
    const { p } = pool({ max: 1 });
    p.call("echo:x", 1000);
    await until(() => p.ready === 1);
    const e = await sent(p, "reject").catch((e) => e);
    expect(e).toBeInstanceOf(ExecutionWorkerError);
    expect((e as ExecutionWorkerError).reason).toBe("failed");
    expect((e as Error).message).toBe("the execution worker failed the call: no such call");
    expect(await sent(p, "echo:still")).toBe("still");
  });

  for (const how of ["spin", "await-spin"] as const) {
    test(`a call that never yields (${how}) times out; its worker's other calls fail; others answer meanwhile`, async () => {
      const { p, lines } = pool({ max: 2 });
      p.call("echo:x", 1000);
      await until(() => p.ready === 1);
      const bystander = sent(p, "wait:5000", 1000);
      const stuck = sent(p, how, 100);
      await until(() => p.ready === 2);
      // The main thread runs, and the other worker answers, while the first spins.
      expect(await sent(p, "echo:meanwhile")).toBe("meanwhile");
      const t = performance.now();
      const e = await stuck.catch((e) => e);
      expect(e).toBeInstanceOf(ExecutionWorkerError);
      expect((e as ExecutionWorkerError).reason).toBe("timeout");
      expect((e as Error).message).toBe("Function execution timed out (maximum duration: 100ms)");
      // Stopped at the longest limit of its calls (the bystander's 1 s) plus the slack.
      expect(performance.now() - t).toBeLessThan(1500);
      const b = await bystander.catch((e) => e);
      expect((b as ExecutionWorkerError).reason).toBe("stuck");
      expect(p.counts.stuck).toBe(1);
      expect(p.size).toBe(1);
      expect(lines.some((l) => l.startsWith("An execution worker ran JavaScript that never yields"))).toBe(true);
    });
  }

  test("busy is not stuck: a call past its limit that keeps resuming, or waits idle, is not terminated", async () => {
    const { p } = pool({ max: 2 });
    p.call("echo:x", 1000);
    await until(() => p.ready === 1);
    expect(await Promise.all([sent(p, "busy:400", 100), sent(p, "wait:400", 100)])).toEqual(["busy", "waited"]);
    expect(p.counts.stuck).toBe(0);
  });

  test("a worker that cannot start: logged once, retried later, calls in-thread meanwhile", async () => {
    let init = "fail";
    const { p, lines } = pool({ max: 1, init: () => init });
    expect(p.call("echo:a", 1000)).toBeNull();
    await until(() => p.counts.failedStarts === 1);
    expect(p.size).toBe(0);
    expect(lines).toEqual([
      "An execution worker could not start: cannot open the store. Calls run on the main thread until one starts.",
    ]);
    // Within the wait, no new start.
    expect(p.call("echo:a", 1000)).toBeNull();
    expect(p.counts.started).toBe(1);
    init = "";
    await Bun.sleep(1050);
    expect(p.call("echo:a", 1000)).toBeNull();
    expect(p.counts.started).toBe(2);
    await until(() => p.ready === 1);
    expect(await sent(p, "echo:b")).toBe("b");
  });

  test("a worker that does not answer its start is ended", async () => {
    const { p, lines } = pool({ max: 1, init: () => "hang", startTimeoutMs: 100 });
    expect(p.call("echo:a", 1000)).toBeNull();
    await until(() => p.counts.failedStarts === 1);
    expect(p.size).toBe(0);
    expect(lines).toEqual([
      "An execution worker could not start: no answer within 100 ms. Calls run on the main thread until one starts.",
    ]);
  });

  test("close ends every worker; calls in flight fail, later ones answer null", async () => {
    const { p } = pool({ max: 1 });
    p.call("echo:x", 1000);
    await until(() => p.ready === 1);
    const inFlight = sent(p, "wait:10000");
    await p.close();
    expect(p.size).toBe(0);
    const e = await inFlight.catch((e) => e);
    expect((e as ExecutionWorkerError).reason).toBe("closed");
    expect(p.call("echo:x", 1000)).toBeNull();
    expect(p.counts.died).toBe(0);
  });
});
