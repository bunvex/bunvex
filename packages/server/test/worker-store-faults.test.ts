// Background workers and store faults: a store read failing where a worker records a failure or looks for its
// next task is logged and retried, never let out as an unhandled rejection (which ends the process). Convex's
// workers run in a loop that logs, backs off and tries again (crates/application/src/exports/worker.rs,
// snapshot_import/worker.rs). The cron executor's case is in cron.test.ts.
import { afterEach, expect, test } from "bun:test";
import { defineSchema, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { MemoryBlobStore } from "@bunvex/file-storage";
import { ExportError, ExportService } from "../src/exports.ts";
import { ImportService } from "../src/imports.ts";
import { captureErrors, failingReads, watchUnhandled } from "./faulty-store.ts";

const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
});
async function until<T>(f: () => Promise<T | undefined | false> | T | undefined | false, what = "condition") {
  for (let i = 0; i < 1000; i++) {
    const x = await f();
    if (x) return x;
    await Bun.sleep(5);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function setup() {
  const { store, state } = failingReads(await MemoryPersistence.open(null, { durable: false }));
  const engine = await new Engine(defineSchema({}), store).init();
  const unhandled = watchUnhandled();
  const logged = captureErrors();
  stops.push(unhandled.stop, logged.stop);
  return { engine, state, unhandled, logged };
}

test("export worker: recording a failed export while the store fails reads is retried", async () => {
  const { engine, state, unhandled, logged } = await setup();
  const svc = new ExportService(engine, new MemoryBlobStore(), null, { deploymentName: "t" });
  stops.push(() => svc.stop());
  // The export fails with its own error; the first time, the store fails reads just then.
  let runs = 0;
  (svc as unknown as { run: () => Promise<void> }).run = async () => {
    if (runs++ === 0) state.failing = true;
    throw new ExportError(400, "Refused", "refused");
  };
  svc.start();
  const id = await svc.request(false);
  await until(() => logged.calls.some((c) => String(c[0]).includes("as failed")), "the failure to be logged");
  expect(unhandled.seen).toEqual([]);
  state.failing = false;
  const row = await until(async () => {
    const r = (await engine.query((db) => db.asSystem(() => db.get("_exports", id)))) as { state: string } | null;
    return r?.state === "failed" && r;
  }, "the export to be recorded failed");
  expect(row.state).toBe("failed");
  expect(unhandled.seen).toEqual([]);
});

test("import worker: dropping a failed import's tables while the store fails reads is not fatal", async () => {
  const { engine, state, unhandled, logged } = await setup();
  const svc = new ImportService(engine, new MemoryBlobStore(), null, { retryBackoffMs: { initial: 20, max: 100 } });
  stops.push(() => svc.stop());
  // The import fails with its own error; the first time, the store fails reads just then.
  let runs = 0;
  (svc as unknown as { confirmable: () => Promise<void> }).confirmable = async () => {
    if (runs++ === 0) state.failing = true;
    throw new Error("not an import");
  };
  svc.startWorker();
  const id = await svc.start("jsonl" as never, "append" as never, { key: "k", size: 0 });
  await until(() => logged.calls.some((c) => String(c[0]).includes("dropping its tables failed")), "the log");
  await until(() => logged.calls.some((c) => String(c[0]).includes("finding the next import failed")), "a retry");
  expect(unhandled.seen).toEqual([]);
  state.failing = false;
  const row = await until(async () => {
    const r = await svc.row(id);
    return r?.state.state === "failed" && r;
  }, "the import to be recorded failed");
  expect(row.state.state).toBe("failed");
  expect(unhandled.seen).toEqual([]);
});
