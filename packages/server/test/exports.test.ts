// Snapshot exports (STUDY-42 PR 1), end to end over HTTP: Convex's ZIP layout and lossless encoding, one
// snapshot, `_storage` with its files, one export at a time, downloads (admin key or token), expiration,
// cancellation, cleanup, the operations each route needs.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { MemoryBlobStore } from "@bunvex/file-storage";
import { fromExportJson, v } from "@bunvex/values";
import { adminKeyCipherKey, issueAdminKey } from "../src/admin-keys.ts";
import { EXPORT_README, ExportService } from "../src/exports.ts";
import { Functions, mutation } from "../src/functions.ts";
import { createServer } from "../src/server.ts";

const SECRET = "56".repeat(32);
const NAME = "export-test";
const KEY = issueAdminKey({ instanceName: NAME, cipherKey: adminKeyCipherKey(SECRET) });
const READ_ONLY = issueAdminKey({ instanceName: NAME, cipherKey: adminKeyCipherKey(SECRET), readOnly: true });

const stops: (() => unknown)[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function setup() {
  const engine = await new Engine(
    defineSchema({ messages: defineTable(v.any()), users: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
    { instanceName: NAME, instanceSecret: SECRET },
  ).init();
  const functions = new Functions(engine).register("m", {
    insert: mutation(async ({ db }, { table, doc }: { table: string; doc: Record<string, unknown> }) =>
      db.insert(table, doc),
    ),
    uploadUrl: mutation(async ({ storage }) => storage.generateUploadUrl()),
  });
  const exportStore = new MemoryBlobStore();
  const s = createServer({
    engine,
    functions,
    port: 0,
    fileStorage: new MemoryBlobStore(),
    exportStorage: exportStore,
  });
  stops.push(() => s.shutdown());
  const api = `http://127.0.0.1:${s.server.port}`;
  const post = (path: string, body: object = {}, key: string | null = KEY) =>
    fetch(`${api}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(key ? { authorization: `Bunvex ${key}` } : {}) },
      body: JSON.stringify(body),
    });
  const latest = async () =>
    (
      (await (
        await post("/api/query", { path: "_system/cli/exports:getLatest", args: {}, format: "convex_encoded_json" })
      ).json()) as {
        value: Record<string, unknown> | null;
      }
    ).value;
  const waitDone = async () => {
    for (let i = 0; i < 400; i++) {
      const l = await latest();
      if (l && ["completed", "failed", "canceled"].includes(l.state as string)) return l;
      await Bun.sleep(25);
    }
    throw new Error("export did not finish");
  };
  const tsOf = (l: Record<string, unknown>) =>
    Buffer.from((l.start_ts as { $integer: string }).$integer, "base64").readBigInt64LE();
  const download = async (id: string, key: string | null = KEY, query = "") =>
    fetch(`${api}/api/export/zip/${id}${query}`, { headers: key ? { authorization: `Bunvex ${key}` } : {} });
  return { engine, functions, api, post, latest, waitDone, tsOf, download, exportStore };
}

/** The ZIP's entries in order, and each one's text, via `unzip` (Info-ZIP reads what Convex's tools read). */
async function unzip(bytes: ArrayBuffer) {
  const d = mkdtempSync(join(tmpdir(), "bunvex-export-"));
  dirs.push(d);
  const f = join(d, "x.zip");
  await Bun.write(f, bytes);
  const names = Bun.spawnSync(["unzip", "-Z1", f]).stdout.toString().trim().split("\n");
  const read = (name: string) => Bun.spawnSync(["unzip", "-p", f, name]).stdout.toString();
  return { names, read };
}

describe("snapshot export", () => {
  test("Convex's ZIP: README, _tables, each table smallest first, the lossless encoding; downloads", async () => {
    const t = await setup();
    const big = [];
    for (let i = 0; i < 3; i++)
      big.push(
        await t.functions.runMutation("m:insert", { table: "messages", doc: { body: "x".repeat(50), n: BigInt(i) } }),
      );
    const u = await t.functions.runMutation("m:insert", {
      table: "users",
      doc: {
        name: "Ada",
        Z: 1,
        score: 2.5,
        whole: 3,
        tiny: -0,
        nan: Number.NaN,
        bytes: new Uint8Array([1, 2]).buffer,
        nested: { b: 1n, a: [{ y: 1, x: 2 }] },
      },
    });
    expect((await t.post("/api/export/request/zip")).status).toBe(200);
    const done = await t.waitDone();
    expect(done.state).toBe("completed");
    const ts = t.tsOf(done);
    const res = await t.download(String(ts));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename=snapshot_${NAME}_${ts}.zip`);
    expect(res.headers.get("cache-control")).toBe("private, max-age=2592000");
    const zip = await unzip(await res.arrayBuffer());
    // users (1 small doc) before messages (3 docs).
    expect(zip.names).toEqual([
      "README.md",
      "_tables/documents.jsonl",
      "users/documents.jsonl",
      "users/generated_schema.jsonl",
      "messages/documents.jsonl",
      "messages/generated_schema.jsonl",
    ]);
    expect(zip.read("README.md")).toBe(EXPORT_README);
    expect(zip.read("_tables/documents.jsonl")).toBe('{"name":"messages","id":10001}\n{"name":"users","id":10002}\n');
    expect(zip.read("users/generated_schema.jsonl")).toBe('"uniform"\n');
    const userLine = zip.read("users/documents.jsonl").trimEnd();
    expect(userLine).toStartWith('{"Z":1.0,"_creationTime":');
    expect(userLine).toContain(
      `"_id":"${u}","bytes":{"$bytes":"AQI="},"name":"Ada","nan":{"$float":"AAAAAAAA+H8="},"nested":{"a":[{"x":2.0,"y":1.0}],"b":1},"score":2.5,"tiny":-0.0,"whole":3.0}`,
    );
    const messages = zip
      .read("messages/documents.jsonl")
      .trimEnd()
      .split("\n")
      .map((l) => fromExportJson(l) as Record<string, unknown>);
    expect(messages.map((m) => m._id)).toEqual([...big].sort());
    expect(messages.map((m) => m.n).sort()).toEqual([0n, 1n, 2n]);
    // By the export's id too.
    expect((await t.download(done._id as string)).status).toBe(200);
  });

  test("_storage: its metadata and every file, when asked", async () => {
    const t = await setup();
    const url = (await t.functions.runMutation("m:uploadUrl", {})) as string;
    const { storageId } = (await (
      await fetch(url, { method: "POST", body: "hello", headers: { "content-type": "image/png" } })
    ).json()) as { storageId: string };
    await t.post("/api/export/request/zip?includeStorage=true");
    const done = await t.waitDone();
    const zip = await unzip(await (await t.download(String(t.tsOf(done)))).arrayBuffer());
    expect(zip.names.slice(-2)).toEqual(["_storage/documents.jsonl", `_storage/${storageId}.png`]);
    const meta = JSON.parse(zip.read("_storage/documents.jsonl")) as Record<string, unknown>;
    expect(Object.keys(meta)).toEqual(["_id", "_creationTime", "sha256", "size", "contentType", "internalId"]);
    expect(meta).toMatchObject({ _id: storageId, size: 5, contentType: "image/png" });
    expect(zip.read(`_storage/${storageId}.png`)).toBe("hello");
    // Without includeStorage: no _storage.
    await t.post("/api/export/request/zip");
    const plain = await unzip(await (await t.download(String(t.tsOf(await t.waitDone())))).arrayBuffer());
    expect(plain.names.some((n) => n.startsWith("_storage"))).toBe(false);
  });

  test("one snapshot: documents written while the export runs are not in it", async () => {
    const t = await setup();
    for (let i = 0; i < 2500; i++) await t.functions.runMutation("m:insert", { table: "messages", doc: { i } });
    await t.post("/api/export/request/zip");
    const writes = Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        t.functions.runMutation("m:insert", { table: "messages", doc: { late: i } }),
      ),
    );
    const done = await t.waitDone();
    await writes;
    const zip = await unzip(await (await t.download(String(t.tsOf(done)))).arrayBuffer());
    const lines = zip.read("messages/documents.jsonl").trimEnd().split("\n");
    // Whatever committed before the snapshot, nothing after: a consistent count, every line from one ts.
    const count = lines.length;
    expect(count).toBeGreaterThanOrEqual(2500);
    expect(lines.filter((l) => l.includes('"late"')).length).toBe(count - 2500);
  });

  test("one at a time; errors; a token download; expiration; cancel; operations", async () => {
    const t = await setup();
    await t.post("/api/export/request/zip");
    const second = await t.post("/api/export/request/zip");
    // Either still running (refused) or already finished (accepted): when refused, Convex's error.
    if (second.status !== 200)
      expect(await second.json()).toEqual({
        code: "ExportInProgress",
        message: "There is already an export requested or in progress.",
      });
    const done = await t.waitDone();
    const ts = String(t.tsOf(done));
    expect(await (await t.download("123")).json()).toEqual({
      code: "ExportNotFound",
      message: "The requested export 123 was not found",
    });
    expect(await (await t.download("nope")).json()).toEqual({
      code: "BadSnapshotId",
      message: "Snapshot Id did not parse to an ID.",
    });
    // A read-only key downloads but cannot request; no key cannot download.
    expect((await t.download(ts, READ_ONLY)).status).toBe(200);
    expect((await t.post("/api/export/request/zip", {}, READ_ONLY)).status).toBe(403);
    expect((await t.download(ts, null)).status).toBe(403);
    // A token download, for a browser.
    const { token } = (await (await t.post(`/api/export/zip/${ts}/token`)).json()) as { token: string };
    expect((await t.download(ts, null, `?token=${token}`)).status).toBe(200);
    expect((await t.download(ts, null, "?token=1.bad")).status).toBe(403);
    // Expiration: not in the past, at most 60 days ahead.
    const now = BigInt(Date.now()) * 1_000_000n;
    const day = 86_400_000_000_000n;
    expect(
      await (await t.post(`/api/export/set_expiration/${done._id}`, { expirationTsNs: String(now - day) })).json(),
    ).toMatchObject({
      message: "Snapshot expiration in past.",
    });
    expect(
      await (
        await t.post(`/api/export/set_expiration/${done._id}`, { expirationTsNs: String(now + 62n * day) })
      ).json(),
    ).toMatchObject({
      message: expect.stringMatching(/^Snapshot expiration is 6[12] days in the future\. Must be <= 60$/),
    });
    expect(
      (await t.post(`/api/export/set_expiration/${done._id}`, { expirationTsNs: String(now + 30n * day) })).status,
    ).toBe(200);
  });
});

describe("the export service", () => {
  test("cancel stops a running export and keeps no ZIP; cleanup deletes old exports and their ZIPs", async () => {
    const engine = await new Engine(
      defineSchema({ items: defineTable(v.any()) }),
      await MemoryPersistence.open(null, { durable: false }),
    ).init();
    stops.push(() => engine.close());
    await engine.mutation((db) => db.insert("items", { n: 1 }));
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const store = new MemoryBlobStore();
    const put = store.put.bind(store);
    let hold = true;
    store.put = async (body) => {
      if (hold) await gate;
      return put(body);
    };
    let now = Date.now();
    const svc = new ExportService(engine, store, null, { deploymentName: "x", now: () => now });
    svc.start();
    stops.push(() => svc.stop());
    const row = () => engine.query((db) => svc.latest(db));
    const until = async (state: string) => {
      for (let i = 0; i < 200 && (await row())?.state !== state; i++) await Bun.sleep(10);
      return row();
    };
    const id = await svc.request(false);
    await until("in_progress");
    // One at a time: refused while this one runs.
    await expect(svc.request(false)).rejects.toThrow("There is already an export requested or in progress.");
    await svc.cancel(id);
    release();
    expect((await until("canceled"))?.state).toBe("canceled");
    await Bun.sleep(50);
    const keys = async () => {
      const out: string[] = [];
      for await (const l of store.list()) out.push(l.key);
      return out;
    };
    expect(await keys()).toEqual([]);
    await expect(svc.cancel(id)).rejects.toThrow(`The requested export ${id} has already canceled`);
    // A completed export, then time passing: 14 days to expire, 30 more before cleanup.
    hold = false;
    await svc.request(false);
    await until("completed");
    expect((await keys()).length).toBe(1);
    // 43 days on: the canceled one is 30 days past its cancellation; the completed one is not yet 30 days past
    // its expiration (14 days).
    now += 43 * 86_400_000;
    expect(await svc.cleanup()).toBe(1);
    expect((await keys()).length).toBe(1);
    now += 2 * 86_400_000;
    expect(await svc.cleanup()).toBe(1);
    expect(await keys()).toEqual([]);
    expect(await row()).toBe(null);
  });
});
