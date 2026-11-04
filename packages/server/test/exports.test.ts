// Snapshot exports (STUDY-42 PR 1), end to end over HTTP: Convex's ZIP layout and lossless encoding, one
// snapshot, `_storage` with its files, one export at a time, downloads (admin key or token), expiration,
// cancellation, cleanup, the operations each route needs.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  componentRow,
  DEPLOYMENT_AUDIT_LOG_TABLE,
  defineSchema,
  defineTable,
  Engine,
  FILE_STORAGE_TABLE,
} from "@bunvex/core";
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
  const fileStorage = new MemoryBlobStore();
  const s = createServer({
    engine,
    functions,
    port: 0,
    fileStorage,
    exportStorage: exportStore,
  });
  stops.push(() => s.shutdown());
  const api = `http://127.0.0.1:${s.server.port}`;
  /** A POST; a string body is sent as written (an integer past 2^53, exact). */
  const post = (path: string, body: object | string = {}, key: string | null = KEY) =>
    fetch(`${api}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(key ? { authorization: `Bunvex ${key}` } : {}) },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  const latest = async () =>
    (
      (await (
        await post("/api/query", { path: "_system/cli/exports:getLatest", args: {}, format: "encoded_json" })
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
  return { engine, functions, api, post, latest, waitDone, tsOf, download, exportStore, fileStorage };
}

/**
 * The ZIP's entries in order, and each one's text, via `unzip` (Info-ZIP reads what Convex's tools read).
 * Two async runs, their output in files: no `Bun.spawnSync`, no stdout pipe. On a loaded CI runner a
 * `spawnSync` whose child had already exited 0 once sat until the 5 s test timeout killed it ("killed 1
 * dangling process"), and this test, the zip-reader's and the CLI's spawnSync tests all failed so in one job.
 */
async function unzip(bytes: ArrayBuffer) {
  const d = mkdtempSync(join(tmpdir(), "bunvex-export-"));
  dirs.push(d);
  const f = join(d, "x.zip");
  const list = join(d, "names.txt");
  const out = join(d, "out");
  await Bun.write(f, bytes);
  const run = async (args: string[], stdout: "ignore" | ReturnType<typeof Bun.file>) => {
    const code = await Bun.spawn(["unzip", ...args], { stdin: "ignore", stdout, stderr: "inherit" }).exited;
    if (code !== 0) throw new Error(`unzip ${args.join(" ")} exited ${code}`);
  };
  await run(["-Z1", f], Bun.file(list));
  await run(["-q", f, "-d", out], "ignore");
  const names = (await Bun.file(list).text()).trim().split("\n");
  const read = (name: string) => readFileSync(join(out, name), "utf8");
  return { names, read };
}

/**
 * Components as a push leaves them: `counter` and `second` under the root, `inner` under `counter`, each namespace
 * with its own `messages` (and `counter` its `counters`), one document each, written in its namespace; the root's
 * `messages` has one too.
 */
async function addComponents(engine: Engine) {
  const ids = {
    counter: await engine.initializeComponentNamespace(),
    second: await engine.initializeComponentNamespace(),
    inner: await engine.initializeComponentNamespace(),
  };
  await engine.mutation((db) =>
    db.asSystem(async () => {
      const definitionId = await db.insert("_component_definitions", { path: "c" } as never);
      const root = await db.insert(
        "_components",
        componentRow({ definitionId, parent: null, name: null, state: "active", httpPrefix: null }) as never,
      );
      const add = (id: string, parent: string, name: string) =>
        db.importInsert(engine.catalog.table("_components")!, {
          _id: id,
          ...componentRow({ definitionId, parent, name, args: [], env: [], state: "active", httpPrefix: null }),
        });
      await add(ids.counter, root, "counter");
      await add(ids.second, root, "second");
      await add(ids.inner, ids.counter, "inner");
    }),
  );
  await engine.mutation(async (db) => {
    await db.insert("messages", { text: "root" });
    for (const [name, id] of Object.entries(ids))
      await db.inComponent(id, async () => {
        await db.insert("messages", { body: `in ${name}` });
        if (name === "counter") await db.insert("counters", { name, value: 1 });
      });
  });
  return ids;
}

describe("snapshot export", () => {
  test("every component's tables, under its path's prefix, after the root's (Convex's `_components/<name>/`)", async () => {
    const t = await setup();
    await addComponents(t.engine);
    expect((await t.post("/api/export/request/zip")).status).toBe(200);
    const done = await t.waitDone();
    expect(done.state).toBe("completed");
    const zip = await unzip(await (await t.download(String(t.tsOf(done)))).arrayBuffer());
    // Each namespace's `_tables` first, the root's before the others; then every table, smallest first.
    const tablesFiles = [
      "_components/counter/_components/inner/_tables/documents.jsonl",
      "_components/counter/_tables/documents.jsonl",
      "_components/second/_tables/documents.jsonl",
    ];
    expect(zip.names.slice(0, 2)).toEqual(["README.md", "_tables/documents.jsonl"]);
    expect(zip.names.slice(2, 5).sort()).toEqual(tablesFiles);
    const table = (prefix: string, name: string) => [
      `${prefix}${name}/documents.jsonl`,
      `${prefix}${name}/generated_schema.jsonl`,
    ];
    expect([...zip.names].sort()).toEqual(
      [
        "README.md",
        "_tables/documents.jsonl",
        ...tablesFiles,
        ...table("", "messages"),
        ...table("", "users"),
        ...table("_components/counter/", "messages"),
        ...table("_components/counter/", "counters"),
        ...table("_components/second/", "messages"),
        ...table("_components/counter/_components/inner/", "messages"),
      ].sort(),
    );
    // A component's `_tables` lists its own tables, at its own numbers.
    const listed = (name: string) =>
      zip
        .read(name)
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as { name: string; id: number });
    const counterTables = listed("_components/counter/_tables/documents.jsonl");
    expect(counterTables.map((x) => x.name)).toEqual(["messages", "counters"]);
    const counter = t.engine.catalog.components.get(
      [...t.engine.catalog.components.keys()].find((id) =>
        t.engine.catalog.components.get(id)!.tables.has("counters"),
      )!,
    )!;
    expect(counterTables.map((x) => x.id)).toEqual([
      counter.tables.get("messages")!.number,
      counter.tables.get("counters")!.number,
    ]);
    expect(listed("_tables/documents.jsonl").map((x) => x.name)).toEqual(["messages", "users"]);
    // Each namespace's documents, not another's.
    const docs = (name: string) =>
      zip
        .read(name)
        .trim()
        .split("\n")
        .map((l) => fromExportJson(l) as Record<string, unknown>);
    expect(docs("messages/documents.jsonl").map((m) => m.text)).toEqual(["root"]);
    expect(docs("_components/counter/messages/documents.jsonl").map((m) => m.body)).toEqual(["in counter"]);
    expect(docs("_components/second/messages/documents.jsonl").map((m) => m.body)).toEqual(["in second"]);
    expect(docs("_components/counter/_components/inner/messages/documents.jsonl").map((m) => m.body)).toEqual([
      "in inner",
    ]);
    expect(docs("_components/counter/counters/documents.jsonl").map((m) => m.name)).toEqual(["counter"]);
  });

  test("a component's files under its prefix's `_storage`, after every table", async () => {
    const t = await setup();
    const ids = await addComponents(t.engine);
    const body = new TextEncoder().encode("component file");
    const { key } = await t.fileStorage.put(body);
    const fileId = (await t.engine.mutation((db) =>
      db.inComponent(ids.counter, () =>
        db.asSystem(() =>
          db.insert(FILE_STORAGE_TABLE, {
            storageId: "4b5f6c1e-2a3d-4e5f-8a9b-0c1d2e3f4a5b",
            storageKey: key,
            sha256: new Uint8Array(32).buffer,
            size: BigInt(body.length),
            contentType: "text/plain",
          }),
        ),
      ),
    )) as string;
    await t.post("/api/export/request/zip?includeStorage=true");
    const done = await t.waitDone();
    expect(done.state).toBe("completed");
    const zip = await unzip(await (await t.download(String(t.tsOf(done)))).arrayBuffer());
    const storage = zip.names.filter((n) => n.includes("_storage/"));
    expect(storage[0]).toBe("_storage/documents.jsonl");
    expect([...storage].sort()).toEqual(
      [
        "_storage/documents.jsonl",
        "_components/counter/_storage/documents.jsonl",
        `_components/counter/_storage/${fileId}.txt`,
        "_components/second/_storage/documents.jsonl",
        "_components/counter/_components/inner/_storage/documents.jsonl",
      ].sort(),
    );
    // A namespace's metadata just before its files.
    const meta = zip.names.indexOf("_components/counter/_storage/documents.jsonl");
    expect(zip.names[meta + 1]).toBe(`_components/counter/_storage/${fileId}.txt`);
    expect(zip.names.indexOf("_storage/documents.jsonl")).toBeGreaterThan(
      Math.max(...zip.names.filter((n) => n.endsWith("generated_schema.jsonl")).map((n) => zip.names.indexOf(n))),
    );
    expect(zip.read(`_components/counter/_storage/${fileId}.txt`)).toBe("component file");
    expect(zip.read("_components/counter/_storage/documents.jsonl")).toContain(`"_id":"${fileId}"`);
    expect(zip.read("_storage/documents.jsonl")).toBe("");
  });

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
      await (await t.post(`/api/export/set_expiration/${done._id}`, `{"expirationTsNs":${now - day}}`)).json(),
    ).toMatchObject({
      message: "Snapshot expiration in past.",
    });
    expect(
      await (await t.post(`/api/export/set_expiration/${done._id}`, `{"expirationTsNs":${now + 62n * day}}`)).json(),
    ).toMatchObject({
      message: expect.stringMatching(/^Snapshot expiration is 6[12] days in the future\. Must be <= 60$/),
    });
    expect(
      (await t.post(`/api/export/set_expiration/${done._id}`, `{"expirationTsNs":${now + 30n * day}}`)).status,
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

describe("download_export in the audit log (Convex's 8281a65)", () => {
  test("each download, by the key's member or the token's, with the export's id and format", async () => {
    const t = await setup();
    const SEVEN = issueAdminKey({ instanceName: NAME, cipherKey: adminKeyCipherKey(SECRET), memberId: 7 });
    await t.post("/api/export/request/zip?includeStorage=true");
    const done = await t.waitDone();
    const ts = String(t.tsOf(done));
    const downloads = async () =>
      (await t.engine.query((db) => db.asSystem(() => db.query(DEPLOYMENT_AUDIT_LOG_TABLE).collect())))
        .filter((e) => e.action === "download_export")
        .map((e) => [e.member_id ?? null, e.metadata]);
    const metadata = {
      id: done._id,
      component_id: null,
      component: null,
      format: "zip_with_storage",
      requestor: "snapshot_export",
    };
    expect(await downloads()).toEqual([]);
    expect((await t.download(ts, SEVEN)).status).toBe(200);
    expect((await t.download(done._id as string, KEY)).status).toBe(200);
    expect(await downloads()).toEqual([
      [7n, metadata],
      [0n, metadata],
    ]);
    // A token names whoever asked for it.
    const { token } = (await (await t.post(`/api/export/zip/${ts}/token`, {}, SEVEN)).json()) as { token: string };
    expect((await t.download(ts, null, `?token=${token}`)).status).toBe(200);
    expect((await downloads()).at(-1)).toEqual([7n, metadata]);
    // Its member cannot be swapped.
    const [expires, , mac] = token.split(".");
    expect((await t.download(ts, null, `?token=${expires}.8.${mac}`)).status).toBe(403);
    expect((await t.download(ts, null, `?token=${expires}..${mac}`)).status).toBe(403);
    // A failed download records nothing.
    const before = (await downloads()).length;
    expect((await t.download("123", KEY)).status).toBe(404);
    expect((await downloads()).length).toBe(before);
  });
});
