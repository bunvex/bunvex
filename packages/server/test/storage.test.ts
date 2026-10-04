// File storage (STUDY-32 PR 2): ctx.storage per context, `_storage` through db.system, the upload and
// download routes, tokens, CORS, the F3 sweeps and the F4 body caps.
import { afterEach, describe, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { MemoryBlobStore } from "@bunvex/file-storage";
import { v } from "@bunvex/values";
import { type RequestDestination, setCanonicalUrl } from "../src/canonical-urls.ts";
import { action, Functions, mutation, query } from "../src/functions.ts";
import { httpAction, httpRouter } from "../src/router.ts";
import { createServer } from "../src/server.ts";
import { FileStorage } from "../src/storage.ts";
import { add, history, syncUrl, v1Client } from "./v1-client.ts";

const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
});

const sha256b64 = (s: string) => Buffer.from(new Bun.CryptoHasher("sha256").update(s).digest()).toString("base64");
const msg = async (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e: Error) => e.message,
  );

async function setup(opts: { maxRequestBodySize?: number } = {}) {
  const engine = await new Engine(
    defineSchema({ items: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
  ).init();
  const blobs = new MemoryBlobStore();
  const functions = new Functions(engine).register("m", {
    url: query(async ({ storage }, { id }: { id: string }) => storage.getUrl(id)),
    urlNoArg: query(async ({ storage }) =>
      (storage.getUrl as (x?: string) => Promise<unknown>)().catch((e: Error) => e.message),
    ),
    meta: query(async ({ storage }, { id }: { id: string }) => storage.getMetadata(id)),
    doc: query(async ({ db }, { id }: { id: string }) => db.system.get(id as never)),
    docs: query(async ({ db }) => db.system.query("_storage").collect()),
    otherId: mutation(async ({ db }) => db.insert("items", {})),
    uploadUrl: mutation(async ({ storage }) => storage.generateUploadUrl()),
    uploadUrlFromAction: action(async ({ storage }) => storage.generateUploadUrl()),
    urlFromAction: action(async ({ storage }, { id }: { id: string }) => storage.getUrl(id)),
    del: mutation(async ({ storage }, { id, fail }: { id: string; fail?: boolean }) => {
      await storage.delete(id);
      if (fail) throw new Error("rolled back");
    }),
    storeInMutation: mutation(async ({ storage }) => storage.store(new Blob(["x"]))),
    storeBlob: action(async ({ storage }, { text, type, sha256 }: { text: string; type?: string; sha256?: string }) =>
      storage.store(new Blob([text], type ? { type } : {}), sha256 ? { sha256 } : undefined),
    ),
    storeNotBlob: action(async ({ storage }) => storage.store("x" as never)),
    getBlob: action(async ({ storage }, { id }: { id: string }) => {
      const b = await storage.get(id);
      return b && { text: await b.text(), type: b.type, size: b.size };
    }),
    getNotString: action(async ({ storage }) => storage.get(1 as never)),
    delAction: action(async ({ storage }, { id }: { id: string }) => storage.delete(id)),
  });
  const http = httpRouter();
  http.route({
    path: "/file",
    method: "GET",
    handler: httpAction(async (ctx, req) => {
      const blob = await ctx.storage.get(new URL(req.url).searchParams.get("id")!);
      return blob === null ? new Response("Image not found", { status: 404 }) : new Response(blob);
    }),
  });
  http.route({
    path: "/echo",
    method: "POST",
    handler: httpAction(async (_ctx, req) => new Response(await req.text())),
  });
  const server = createServer({
    engine,
    functions,
    port: 0,
    fileStorage: blobs,
    http,
    maxRequestBodySize: opts.maxRequestBodySize,
  });
  stops.push(server.stop);
  const api = `http://127.0.0.1:${server.server.port}`;
  const upload = async (body: string | Blob | Uint8Array, headers: Record<string, string> = {}) => {
    const url = (await functions.runMutation("m:uploadUrl", {})) as string;
    return fetch(url, { method: "POST", body, headers });
  };
  const storeText = async (text: string, type = "text/plain") =>
    ((await (await upload(text, type ? { "content-type": type } : {})).json()) as { storageId: string }).storageId;
  return { engine, functions, blobs, server, api, upload, storeText };
}

describe("uploads and _storage", () => {
  test("generateUploadUrl → POST → {storageId}; the _storage document in Convex's shape", async () => {
    const { functions, api, upload } = await setup();
    const url = (await functions.runMutation("m:uploadUrl", {})) as string;
    expect(url).toMatch(new RegExp(`^${api}/api/storage/upload\\?token=[0-9a-f]+$`));
    const r = await upload("hello file", { "content-type": "text/plain" });
    expect(r.status).toBe(200);
    const { storageId } = (await r.json()) as { storageId: string };
    const doc = (await functions.runQuery("m:doc", { id: storageId })) as Record<string, unknown>;
    expect(Object.keys(doc).sort()).toEqual(["_creationTime", "_id", "contentType", "sha256", "size"]);
    expect(doc).toMatchObject({ _id: storageId, sha256: sha256b64("hello file"), size: 10, contentType: "text/plain" });
    const bare = ((await (await upload("x")).json()) as { storageId: string }).storageId;
    expect(((await functions.runQuery("m:doc", { id: bare })) as { contentType: unknown }).contentType).toBeNull();
    expect(((await functions.runQuery("m:docs", {})) as unknown[]).length).toBe(2);
    const meta = (await functions.runQuery("m:meta", { id: storageId })) as Record<string, unknown>;
    expect(meta).toMatchObject({
      sha256: Buffer.from(sha256b64("hello file"), "base64").toString("hex"),
      size: 10,
      contentType: "text/plain",
    });
    expect(meta.storageId).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("Digest: checked; a mismatch fails (and stores nothing); a malformed one is BadHeader", async () => {
    const { upload, functions } = await setup();
    expect((await upload("abc", { digest: `sha-256=${sha256b64("abc")}` })).status).toBe(200);
    const bad = await upload("abc", { digest: `sha-256=${sha256b64("abd")}` });
    expect([bad.status, ((await bad.json()) as { code: string }).code]).toEqual([400, "Sha256Mismatch"]);
    const odd = await upload("abc", { digest: "md5=zzz" });
    expect([odd.status, ((await odd.json()) as { code: string }).code]).toEqual([400, "BadHeader"]);
    expect(((await functions.runQuery("m:docs", {})) as unknown[]).length).toBe(1);
  });

  test("tokens: an invalid one, an expired one (401); one reused within its hour", async () => {
    const { api, engine, blobs, functions } = await setup();
    const post = (token: string) => fetch(`${api}/api/storage/upload?token=${token}`, { method: "POST", body: "x" });
    const bad = await post("nope");
    expect([bad.status, await bad.json()]).toEqual([
      401,
      { code: "StorageTokenInvalid", message: "Couldn't decode the StoreFileAuthorization token" },
    ]);
    const old = new FileStorage(engine, blobs, api, () => Date.now() - 2 * 3600_000).uploadToken();
    const expired = await post(old);
    expect([expired.status, await expired.json()]).toEqual([
      401,
      { code: "StorageTokenExpired", message: "Store File Authorization expired" },
    ]);
    const url = (await functions.runMutation("m:uploadUrl", {})) as string;
    for (let i = 0; i < 2; i++) expect((await fetch(url, { method: "POST", body: `again ${i}` })).status).toBe(200);
  });
});

describe("downloads", () => {
  test("getUrl, and the file served with Convex's headers; HEAD; 404; a bad path", async () => {
    const { functions, storeText, api } = await setup();
    const id = await storeText("0123456789");
    const url = (await functions.runQuery("m:url", { id })) as string;
    expect(url).toMatch(new RegExp(`^${api}/api/storage/[0-9a-f-]{36}$`));
    const r = await fetch(url);
    expect(await r.text()).toBe("0123456789");
    expect(
      Object.fromEntries(
        ["digest", "content-type", "content-length", "cache-control", "accept-ranges", "etag"].map((h) => [
          h,
          r.headers.get(h),
        ]),
      ),
    ).toEqual({
      digest: `sha-256=${sha256b64("0123456789")}`,
      "content-type": "text/plain",
      "content-length": "10",
      "cache-control": "private, max-age=2592000",
      "accept-ranges": "bytes",
      etag: null,
    });
    const head = await fetch(url, { method: "HEAD" });
    expect([head.status, head.headers.get("content-length"), await head.text()]).toEqual([200, "10", ""]);
    const gone = await fetch(`${api}/api/storage/${crypto.randomUUID()}`);
    expect([gone.status, ((await gone.json()) as { code: string }).code]).toEqual([404, "FileNotFound"]);
    const path = await fetch(`${api}/api/storage/${id}`);
    expect(path.status).toBe(400);
    expect(((await path.json()) as { message: string }).message).toStartWith(
      `Invalid storage path: "${id}". Please use \`storage.getUrl`,
    );
  });

  test("ranges: one gives 206; several give 416; an unparsable one gives the whole file; a suffix; a 0-byte file", async () => {
    const { functions, storeText } = await setup();
    const url = (await functions.runQuery("m:url", { id: await storeText("0123456789") })) as string;
    const one = await fetch(url, { headers: { range: "bytes=2-5" } });
    expect([one.status, one.headers.get("content-range"), one.headers.get("digest"), await one.text()]).toEqual([
      206,
      "bytes 2-5/10",
      null,
      "2345",
    ]);
    expect((await fetch(url, { headers: { range: "bytes=0-1,3-4" } })).status).toBe(416);
    expect((await fetch(url, { headers: { range: "bytes=50-60" } })).status).toBe(416);
    const junk = await fetch(url, { headers: { range: "items=1-2" } });
    expect([junk.status, await junk.text()]).toEqual([200, "0123456789"]);
    expect(await (await fetch(url, { headers: { range: "bytes=-3" } })).text()).toBe("789");
    const empty = (await functions.runQuery("m:url", { id: await storeText("", "") })) as string;
    expect((await fetch(empty, { headers: { range: "bytes=0-5" } })).status).toBe(200);
  });

  test("CORS as Convex's /api: preflight, and the origin mirrored with credentials", async () => {
    const { functions, storeText } = await setup();
    const url = (await functions.runQuery("m:url", { id: await storeText("x") })) as string;
    const pre = await fetch(url, {
      method: "OPTIONS",
      headers: {
        origin: "https://app.example",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type, digest",
      },
    });
    expect(pre.headers.get("access-control-allow-origin")).toBe("https://app.example");
    expect(pre.headers.get("access-control-allow-headers")).toBe("content-type, digest");
    expect(pre.headers.get("access-control-max-age")).toBe("86400");
    const get = await fetch(url, { headers: { origin: "https://app.example" } });
    expect([
      get.headers.get("access-control-allow-origin"),
      get.headers.get("access-control-allow-credentials"),
    ]).toEqual(["https://app.example", "true"]);
  });
});

describe("ctx.storage", () => {
  test("ids: a _storage id or a legacy UUID; another table's id and garbage get Convex's messages", async () => {
    const { functions, storeText } = await setup();
    const id = await storeText("x");
    const meta = (await functions.runQuery("m:meta", { id })) as { storageId: string };
    expect(await functions.runQuery("m:url", { id: meta.storageId })).toEqual(
      await functions.runQuery("m:url", { id }),
    );
    const other = (await functions.runMutation("m:otherId", {})) as string;
    expect(await msg(functions.runQuery("m:url", { id: other }))).toContain(
      "Invalid argument `storageId` for `storage.getUrl`: Invalid storage ID. Storage ID cannot be an ID on any table other than '_storage'.",
    );
    expect(await msg(functions.runQuery("m:url", { id: "garbage" }))).toContain(
      `Invalid argument \`storageId\` for \`storage.getUrl\`: Invalid storage ID: "garbage". Storage ID should be an Id of '_storage' table, or a UUID string.`,
    );
    expect(await functions.runQuery("m:urlNoArg", {})).toBe("Must provide arg 1 `storageId` to `getUrl`");
    expect(await functions.runQuery("m:url", { id: crypto.randomUUID() })).toBeNull();
  });

  test("delete: transactional (a rolled-back delete keeps the file); a missing file throws", async () => {
    const { functions, storeText, blobs } = await setup();
    const id = await storeText("keep me");
    expect(await msg(functions.runMutation("m:del", { id, fail: true }))).toContain("rolled back");
    expect(await functions.runQuery("m:url", { id })).not.toBeNull();
    await functions.runMutation("m:del", { id });
    expect(await functions.runQuery("m:url", { id })).toBeNull();
    expect(await msg(functions.runMutation("m:del", { id }))).toContain(`storage id ${id} not found`);
    // F3: the blob goes once the delete committed.
    const count = async () => {
      let n = 0;
      for await (const _ of blobs.list()) n++;
      return n;
    };
    for (let i = 0; i < 100 && (await count()) > 0; i++) await Bun.sleep(10);
    expect(await count()).toBe(0);
  });

  test("URLs follow the canonical cloud URL: getUrl from a query and an action, generateUploadUrl from a mutation and an action (Convex: test_storage_get_url, test_storage_generate_upload_url)", async () => {
    const { engine, functions, storeText, api } = await setup();
    const id = await storeText("canonical");
    const canonical = (destination: RequestDestination, url: string | null) =>
      engine.mutation((db) => setCanonicalUrl(db, destination, url));
    const urls = async () => [
      await functions.runQuery("m:url", { id }),
      await functions.runAction("m:urlFromAction", { id }),
      await functions.runMutation("m:uploadUrl", {}),
      await functions.runAction("m:uploadUrlFromAction", {}),
    ];
    const shapes = (origin: string) => [
      expect.stringMatching(new RegExp(`^${origin}/api/storage/[0-9a-f-]{36}$`)),
      expect.stringMatching(new RegExp(`^${origin}/api/storage/[0-9a-f-]{36}$`)),
      expect.stringMatching(new RegExp(`^${origin}/api/storage/upload\\?token=`)),
      expect.stringMatching(new RegExp(`^${origin}/api/storage/upload\\?token=`)),
    ];
    expect(await urls()).toEqual(shapes(api));

    await canonical("bunvexCloud", "https://files.example.com");
    expect(await urls()).toEqual(shapes("https://files\\.example\\.com"));
    // The site URL is for HTTP actions: file URLs do not use it.
    await canonical("bunvexSite", "https://site.example.com");
    expect(await urls()).toEqual(shapes("https://files\\.example\\.com"));
    // Unset: the server's own origin again.
    await canonical("bunvexCloud", null);
    expect(await urls()).toEqual(shapes(api));
  });

  test("a subscribed getUrl re-runs when the canonical cloud URL changes (it is read in the query's transaction)", async () => {
    const { engine, storeText, server, api } = await setup();
    const id = await storeText("watched");
    const c = await v1Client(syncUrl(server.server.port));
    c.modify([add(1, "m:url", { id })]);
    await c.until(() => history(c.transitions(), 1).length === 1);
    expect(history(c.transitions(), 1)[0]).toStartWith(`${api}/api/storage/`);
    await engine.mutation((db) => setCanonicalUrl(db, "bunvexCloud", "https://files.example.com"));
    await c.until(() => history(c.transitions(), 1).length === 2);
    expect(history(c.transitions(), 1)[1]).toStartWith("https://files.example.com/api/storage/");
    c.ws.close();
  });

  test("getUrl is reactive: a subscribed query re-runs when the file is deleted", async () => {
    const { functions, storeText, server } = await setup();
    const id = await storeText("watched");
    const c = await v1Client(syncUrl(server.server.port));
    c.modify([add(1, "m:url", { id })]);
    await c.until(() => history(c.transitions(), 1).length === 1);
    await functions.runMutation("m:del", { id });
    await c.until(() => history(c.transitions(), 1).at(-1) === null);
    c.ws.close();
  });

  test("actions: store (type, sha256) and get; Convex's messages; store refused in mutations", async () => {
    const { functions } = await setup();
    const id = (await functions.runAction("m:storeBlob", { text: "from an action", type: "text/x" })) as string;
    expect(await functions.runAction("m:getBlob", { id })).toEqual({
      text: "from an action",
      type: "text/x",
      size: 14,
    });
    expect(await msg(functions.runAction("m:storeBlob", { text: "a", sha256: sha256b64("b") }))).toContain(
      "Sha256 mismatch. Expected:",
    );
    expect(await msg(functions.runAction("m:storeNotBlob", {}))).toContain(
      "store() expects a Blob. If you are trying to store a Request, `await request.blob()` will give you the correct input.",
    );
    expect(await msg(functions.runAction("m:getNotString", {}))).toContain(
      "storage.get requires a string storageId but received 1",
    );
    expect(await functions.runAction("m:getBlob", { id: crypto.randomUUID() })).toBeNull();
    expect(await msg(functions.runMutation("m:storeInMutation", {}))).toContain(
      "ctx.storage.store() is not supported in queries and mutations yet. Please use an action, or ctx.storage.generateUploadUrl() to upload from a client.",
    );
    await functions.runAction("m:delAction", { id });
    expect(await functions.runAction("m:getBlob", { id })).toBeNull();
  });

  test("an HTTP action serves a stored file with ctx.storage.get", async () => {
    const { storeText, server } = await setup();
    const id = await storeText("served by http");
    expect(await (await fetch(`${server.siteUrl}/file?id=${id}`)).text()).toBe("served by http");
    expect((await fetch(`${server.siteUrl}/file?id=${crypto.randomUUID()}`)).status).toBe(404);
  });
});

describe("F3 and F4", () => {
  test("blobs no row points to are swept; those with rows stay", async () => {
    const { blobs, server, storeText } = await setup();
    await storeText("kept");
    await blobs.put(new Uint8Array([1, 2, 3])); // an upload whose row never committed
    expect(await server.files!.sweepOrphans(0)).toBe(1);
    let n = 0;
    for await (const _ of blobs.list()) n++;
    expect(n).toBe(1);
  });

  test("uploads have no size limit; every other route keeps maxRequestBodySize", async () => {
    const { upload, api, server } = await setup({ maxRequestBodySize: 1024 });
    expect((await upload("x".repeat(64 * 1024))).status).toBe(200);
    expect(
      (
        await fetch(`${api}/api/query`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "x".repeat(4096),
        })
      ).status,
    ).toBe(413);
    expect((await fetch(`${api}/http/echo`, { method: "POST", body: "x".repeat(4096) })).status).toBe(413);
    expect((await fetch(`${server.siteUrl}/echo`, { method: "POST", body: "x".repeat(4096) })).status).toBe(413);
  });
});
