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
import { adminKeyCipherKey, issueAdminKey } from "../src/admin-keys.ts";
import { ExportService } from "../src/exports.ts";
import { action, mutation } from "../src/functions.ts";
import { ImportService } from "../src/imports.ts";
import { createServer, Functions } from "../src/index.ts";
import { syncUrl } from "./v1-client.ts";

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

// B7 (2026-11-03 audit): as Convex's `run_server_inner`, a shutdown drains the requests before the rest stops. Before,
// `server.stop(true)` reset every connection at once: a client's request in flight got a connection error, its
// mutation's outcome unknown to it.
test("shutdown lets requests in flight finish, refuses new ones, and is not held by a long poll or a websocket", async () => {
  const secret = "5a".repeat(32);
  const key = issueAdminKey({ instanceName: "drain-test", cipherKey: adminKeyCipherKey(secret) });
  const engine = await new Engine(defineSchema({}), await MemoryPersistence.open(null, { durable: false }), {
    instanceName: "drain-test",
    instanceSecret: secret,
  }).init();
  const started = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const functions = new Functions(engine).register("m", {
    slow: action(async (ctx) => {
      started.resolve();
      await gate.promise;
      return ctx.runMutation("m:write" as never, {});
    }),
    write: mutation(async ({ db }) => {
      await db.insert("t", { x: 1 });
      return "written";
    }),
  });
  const s = createServer({ engine, functions, port: 0 });
  const api = `http://127.0.0.1:${s.server.port}`;
  const ws = new WebSocket(syncUrl(s.server.port));
  await new Promise((r) => (ws.onopen = r));
  const wsClosed = new Promise((r) => (ws.onclose = r));
  const inflight = fetch(`${api}/api/action`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: "m:slow", args: {}, format: "json" }),
  }).then((r) => r.json());
  await started.promise;
  // A log stream's long poll waiting for news (up to 60 s).
  const poll = fetch(`${api}/api/stream_function_logs?cursor=0`, { headers: { authorization: `Bunvex ${key}` } });
  await Bun.sleep(50);

  const done = s.shutdown();
  // The long poll answers at once, empty, while the action is still running.
  const polled = await within(poll, 2000, "the long poll");
  expect(polled.status).toBe(200);
  expect(((await polled.json()) as { entries: unknown[] }).entries).toEqual([]);
  // No new connection is taken.
  expect(
    await fetch(`${api}/version`).then(
      () => "answered",
      () => "refused",
    ),
  ).toBe("refused");
  // The request in flight runs to its end, its mutation committed, and its answer arrives.
  gate.resolve();
  expect(await within(inflight, 5000, "the request in flight")).toEqual({ status: "success", value: "written" });
  await within(done, 5000, "the shutdown");
  await within(wsClosed, 2000, "the websocket's close");
});
