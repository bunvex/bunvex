// A deployable server serves nothing of its functions before its deployed code is loaded, as Convex, which
// starts serving once the application is built and loads modules from the store on demand. Here the code is
// read at start (`codeReady`), so until then a call would find no function: an HTTP call or a sync query
// failed with "Could not find public function", and a scheduled job due meanwhile was failed for good. The
// modules store is held back at the restart to open that window wide.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CRON_JOB_LOGS_TABLE, defineSchema, defineTable, Engine } from "@bunvex/core";
import { SqlitePersistence } from "@bunvex/core/persistence/sqlite";
import { type BlobStore, LocalBlobStore } from "@bunvex/file-storage";
import { v } from "@bunvex/values";
import type { ModuleSource } from "../src/code-version.ts";
import { Functions } from "../src/functions.ts";
import { createServer } from "../src/server.ts";
import { add, syncUrl, v1Client } from "./v1-client.ts";

const stops: (() => unknown)[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const mod = (path: string, source: string): ModuleSource => ({ path, source, environment: "isolate" });
const APP = [
  mod(
    "messages.js",
    `import { query, mutation } from "@bunvex/server";
     export const version = query(async () => 7);
     export const later = mutation(async ({ scheduler }, { ms }) => scheduler.runAfter(ms, "messages:add", {}));
     export const add = mutation(async ({ db }) => db.insert("items", {}));
     export const tick = mutation(async ({ db }) => db.insert("items", { tick: true }));`,
  ),
  mod(
    "http.js",
    `import { httpRouter, httpAction } from "@bunvex/server";
     const h = httpRouter();
     h.route({ path: "/hi", method: "GET", handler: httpAction(async () => new Response("hi")) });
     export default h;`,
  ),
  mod(
    "crons.js",
    `import { cronJobs } from "@bunvex/server";
     const c = cronJobs();
     c.interval("tick", { seconds: 1 }, "messages:tick");
     export default c;`,
  ),
];

/** The modules store, its reads held until `release()`. */
function heldBack(store: BlobStore) {
  let release!: () => void;
  const open = new Promise<void>((r) => {
    release = r;
  });
  const held: BlobStore = {
    put: (body) => store.put(body),
    get: async (key, range) => {
      await open;
      return store.get(key, range);
    },
    delete: (key) => store.delete(key),
    list: () => store.list(),
  };
  return { held, release };
}

async function start(dir: string, moduleStorage: BlobStore) {
  const engine = await new Engine(
    defineSchema({ items: defineTable(v.any()) }),
    new SqlitePersistence(join(dir, "db.sqlite"), { durable: true }),
  ).init();
  const s = createServer({
    engine,
    functions: new Functions(engine),
    port: 0,
    sitePort: 0,
    deployable: true,
    moduleStorage,
  });
  const call = async (kind: "query" | "mutation", path: string, args: Record<string, unknown> = {}) =>
    (await (
      await fetch(`http://127.0.0.1:${s.server.port}/api/${kind}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path, args }),
      })
    ).json()) as { status: string; value?: unknown; errorMessage?: string };
  return { engine, s, call };
}

test("calls and scheduled jobs wait for the deployed code at a restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bunvex-ready-"));
  dirs.push(dir);
  const modules = new LocalBlobStore(join(dir, "storage"), "modules");
  const a = await start(dir, modules);
  await a.s.codeReady;
  await a.s.deployCode(APP);
  // A job due shortly after the restart, while the code is still being read.
  expect((await a.call("mutation", "messages:later", { ms: 300 })).status).toBe("success");
  await a.s.shutdown();
  await a.engine.close();

  // What the server logs meanwhile: a cron due in the window finding no function logs it (and retries).
  const errors: string[] = [];
  const consoleError = console.error;
  console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
  stops.push(() => {
    console.error = consoleError;
  });
  const { held, release } = heldBack(modules);
  const restartedAt = BigInt(Date.now()) * 1_000_000n;
  const b = await start(dir, held);
  stops.push(async () => {
    await b.s.shutdown();
    await b.engine.close();
  });
  // Called before the code is loaded: answered once it is.
  const http = b.call("query", "messages:version");
  const action = fetch(`${b.s.siteUrl}/hi`).then(async (r) => [r.status, await r.text()]);
  const ws = await v1Client(syncUrl(b.s.server.port));
  stops.push(() => ws.ws.close());
  ws.modify([add(1, "messages:version")]);
  const synced = ws.transition(0);
  await Bun.sleep(1300); // the job (300 ms) and the cron (every second) are due by now
  release();
  expect(await http).toMatchObject({ status: "success", value: 7 });
  expect(await action).toEqual([200, "hi"]);
  const t = await synced;
  expect(t.modifications).toEqual([expect.objectContaining({ type: "QueryUpdated", queryId: 1, value: 7 })]);
  // The job ran: it was not failed for a function the server had not loaded yet.
  // As an app reads it: `_scheduled_functions`.
  const states = async (): Promise<string[]> =>
    (await b.engine.query((db: any) => db.system.query("_scheduled_functions").collect())).map(
      (j: any) => j.state.kind as string,
    );
  for (let i = 0; i < 100 && (await states()).some((k) => k === "pending" || k === "inProgress"); i++)
    await Bun.sleep(20);
  expect(await states()).toEqual(["success"]);
  const items = await b.engine.query((db) => db.query("items").collect());
  expect(items.filter((i: any) => !i.tick).length).toBe(1);
  // And the cron, due during the load too, ran its function rather than failing to find it.
  const cronLogs = async () =>
    (await b.engine.query((db) => db.asSystem(() => db.query(CRON_JOB_LOGS_TABLE).collect()))).filter(
      (l: any) => l.name === "tick" && l.ts > restartedAt,
    );
  for (let i = 0; i < 100 && (await cronLogs()).length === 0; i++) await Bun.sleep(20);
  const logs = await cronLogs();
  expect(logs.length).toBeGreaterThan(0);
  expect(logs.map((l: any) => l.status.type)).toEqual(logs.map(() => "success"));
  expect(errors.filter((e) => /missing function|Could not find/.test(e))).toEqual([]);
});
