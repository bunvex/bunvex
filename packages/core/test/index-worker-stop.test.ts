// The index worker's stop cuts its failure backoff short (STUDY-174 S4): a worker backing off after a failure,
// up to INDEX_WORKERS_MAX_BACKOFF (30 s), stops at once, as the scheduler does (F5).
import { afterEach, expect, test } from "bun:test";
import { IndexWorker, type IndexWorkerHost } from "../src/index-worker.ts";

const random = Math.random;
afterEach(() => {
  Math.random = random;
});

test("stop during the failure backoff returns at once", async () => {
  let scans = 0;
  const host = {
    committer: { stopped: false },
    system: async () => {
      scans++;
      throw new Error("store unavailable");
    },
  } as unknown as IndexWorkerHost;
  // The longest backoff, without the jitter's luck.
  Math.random = () => 1;
  const worker = new IndexWorker(host, { initialBackoffMs: 60_000, maxBackoffMs: 60_000 }, () => {});
  worker.start();
  for (let i = 0; i < 100 && scans === 0; i++) await Bun.sleep(5);
  expect(scans).toBe(1);
  await Bun.sleep(10); // in the backoff now
  const t0 = performance.now();
  let t!: ReturnType<typeof setTimeout>;
  const late = new Promise<string>((r) => {
    t = setTimeout(() => r("late"), 1000);
  });
  const outcome = await Promise.race([worker.stop().then(() => "stopped"), late]);
  clearTimeout(t);
  expect(outcome).toBe("stopped");
  expect(performance.now() - t0).toBeLessThan(500);
  expect(scans).toBe(1);
});
