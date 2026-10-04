// A server's shutdown stops its background work before the store closes (found as the CLI suite's
// SQLITE_IOERR_VNODE): after `shutdown()` resolves, nothing of the server reads the store again, so a caller
// may delete its files.
import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineSchema, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { SqlitePersistence } from "@bunvex/core/persistence/sqlite";
import { MemoryBlobStore } from "@bunvex/file-storage";
import { ExportService } from "../src/exports.ts";
import { ImportService } from "../src/imports.ts";
import { createServer, Functions } from "../src/index.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("after shutdown, no background task touches the store (its files can be deleted)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bunvex-shutdown-"));
  dirs.push(dir);
  const engine = await new Engine(defineSchema({}), new SqlitePersistence(join(dir, "db.sqlite"), { durable: true }), {
    instanceName: "shutdown-test",
  }).init();
  const errors: unknown[][] = [];
  const spy = spyOn(console, "error").mockImplementation((...a: unknown[]) => void errors.push(a));
  try {
    // The usage-limit worker evaluates at once, then every 20 ms.
    const s = createServer({ engine, functions: new Functions(engine), port: 0, usageLimitIntervalMs: 20 });
    await s.shutdown();
    rmSync(dir, { recursive: true, force: true });
    await Bun.sleep(200);
  } finally {
    spy.mockRestore();
  }
  expect(errors.map((a) => String(a[0]))).toEqual([]);
});

const memoryEngine = async () =>
  new Engine(defineSchema({}), await MemoryPersistence.open(null, { durable: false })).init();
/** `p`, or a failure naming `what` if it has not settled within `ms`. */
const within = <T>(p: Promise<T>, ms: number, what: string) =>
  Promise.race([p, Bun.sleep(ms).then(() => Promise.reject(new Error(`${what} did not finish in ${ms} ms`)))]);

// The workers read the store, then wait for a signal. A signal given while they read (a stop, or a request) was
// lost: the stop never resolved, and the request waited for the next one.
test("the export and import workers stop even when stopped during their first read", async () => {
  const engine = await memoryEngine();
  const exports = new ExportService(engine, new MemoryBlobStore(), null, { deploymentName: "x" });
  exports.start();
  await within(exports.stop(), 2000, "the export worker's stop");
  const imports = new ImportService(engine, new MemoryBlobStore(), null, {});
  imports.startWorker();
  await within(imports.stop(), 2000, "the import worker's stop");
});

test("an export requested while the worker reads is not lost", async () => {
  const engine = await memoryEngine();
  const svc = new ExportService(engine, new MemoryBlobStore(), null, { deploymentName: "x" });
  svc.start();
  await svc.request(false);
  try {
    let state: string | undefined;
    for (let i = 0; i < 300 && state !== "completed"; i++) {
      state = (await engine.query((db) => svc.latest(db)))?.state;
      if (state !== "completed") await Bun.sleep(10);
    }
    expect(state).toBe("completed");
  } finally {
    await svc.stop();
  }
});
