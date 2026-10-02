// The dashboard's file system functions (Convex's _system/frontend/fileStorageV2, STUDY-32): count, page with
// each file's URL, one file, delete one or many (in one transaction), and a new upload URL.
import { afterEach, describe, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { MemoryBlobStore } from "@bunvex/file-storage";
import { v } from "@bunvex/values";
import { Functions, mutation } from "../src/functions.ts";
import { createServer } from "../src/server.ts";

const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
});

const msg = async (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e: Error) => e.message,
  );
const P = "_system/frontend/fileStorageV2:";
type Page = { page: Record<string, unknown>[]; isDone: boolean; continueCursor: string };

async function setup() {
  const engine = await new Engine(
    defineSchema({ items: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
  ).init();
  const functions = new Functions(engine).register("m", {
    otherId: mutation(async ({ db }) => db.insert("items", {})),
  });
  const server = createServer({ engine, functions, port: 0, fileStorage: new MemoryBlobStore() });
  stops.push(server.stop);
  const api = `http://127.0.0.1:${server.server.port}`;
  const query = (name: string, args: Record<string, unknown> = {}) => functions.runSystemQuery(P + name, args);
  const mutate = (name: string, args: Record<string, unknown> = {}) => functions.runSystemMutation(P + name, args);
  /** Upload through a URL from the system mutation, as the dashboard does. */
  const store = async (text: string) => {
    const url = (await mutate("generateUploadUrl")) as string;
    const r = await fetch(url, { method: "POST", body: text, headers: { "content-type": "text/plain" } });
    return ((await r.json()) as { storageId: string }).storageId;
  };
  return { engine, functions, api, query, mutate, store };
}

describe("_system/frontend/fileStorageV2", () => {
  test("numFiles counts _storage; generateUploadUrl gives an upload URL on the API origin", async () => {
    const { query, mutate, store, api } = await setup();
    expect(await query("numFiles")).toBe(0);
    expect(await mutate("generateUploadUrl")).toMatch(new RegExp(`^${api}/api/storage/upload\\?token=[0-9a-f]+$`));
    await store("a");
    await store("b");
    expect(await query("numFiles", { componentId: null })).toBe(2);
  });

  test("fileMetadata: newest first by default, each document with its url first; asc; creation-time bounds", async () => {
    const { query, store, api } = await setup();
    const ids: string[] = [];
    for (const t of ["one", "two", "three"]) ids.push(await store(t));
    const all = (await query("fileMetadata", { paginationOpts: { numItems: 10, cursor: null } })) as Page;
    expect(all.isDone).toBe(true);
    expect(all.page.map((d) => d._id)).toEqual([...ids].reverse());
    const first = all.page[0]!;
    expect(Object.keys(first)).toEqual(["url", "_id", "_creationTime", "sha256", "size", "contentType"]);
    expect(first).toMatchObject({ size: 5, contentType: "text/plain" });
    expect(first.url).toMatch(new RegExp(`^${api}/api/storage/[0-9a-f-]{36}$`));
    expect(await (await fetch(first.url as string)).text()).toBe("three");

    const asc = (await query("fileMetadata", {
      paginationOpts: { numItems: 10, cursor: null },
      filters: { order: "asc" },
    })) as Page;
    expect(asc.page.map((d) => d._id)).toEqual(ids);

    const times = all.page.map((d) => d._creationTime as number).reverse();
    const mid = (await query("fileMetadata", {
      paginationOpts: { numItems: 10, cursor: null },
      filters: { minCreationTime: times[1], maxCreationTime: times[1] },
    })) as Page;
    expect(mid.page.map((d) => d._id)).toEqual([ids[1]]);
    const from = (await query("fileMetadata", {
      paginationOpts: { numItems: 10, cursor: null },
      filters: { minCreationTime: times[1], order: "asc" },
    })) as Page;
    expect(from.page.map((d) => d._id)).toEqual(ids.slice(1));

    // Pages follow the cursor.
    const p1 = (await query("fileMetadata", { paginationOpts: { numItems: 2, cursor: null } })) as Page;
    expect(p1.page.length).toBe(2);
    expect(p1.isDone).toBe(false);
    const p2 = (await query("fileMetadata", { paginationOpts: { numItems: 2, cursor: p1.continueCursor } })) as Page;
    expect(p2.page.map((d) => d._id)).toEqual([ids[0]]);
  });

  test("fileMetadata checks its arguments as Convex's validators", async () => {
    const { query } = await setup();
    expect(await msg(query("fileMetadata", {}))).toStartWith("ArgumentValidationError:");
    expect(
      await msg(query("fileMetadata", { paginationOpts: { numItems: 1, cursor: null }, filters: { order: "up" } })),
    ).toStartWith("ArgumentValidationError:");
  });

  test("getFile: the document with its url; null for another table's id; db.get's error for a malformed id", async () => {
    const { query, store, functions } = await setup();
    const id = await store("hello");
    const f = (await query("getFile", { storageId: id })) as Record<string, unknown>;
    expect(f).toMatchObject({ _id: id, size: 5, contentType: "text/plain" });
    expect(Object.keys(f)[0]).toBe("url");
    const other = (await functions.runMutation("m:otherId", {})) as string;
    expect(await query("getFile", { storageId: other })).toBeNull();
    expect(await msg(query("getFile", { storageId: "no-such-file" }))).toContain("Invalid argument `id`");
  });

  test("deleteFile removes the document and the URL stops serving", async () => {
    const { query, mutate, store } = await setup();
    const id = await store("bye");
    const { url } = (await query("getFile", { storageId: id })) as { url: string };
    expect(await mutate("deleteFile", { storageId: id })).toBeUndefined();
    expect(await query("getFile", { storageId: id })).toBeNull();
    expect((await fetch(url)).status).toBe(404);
    expect(await msg(mutate("deleteFile", { storageId: id }))).toContain("not found");
    expect(await msg(mutate("deleteFile", { storageId: "no-such-file" }))).toStartWith("ArgumentValidationError:");
  });

  test("deleteFiles is one transaction: one bad id deletes none", async () => {
    const { query, mutate, store } = await setup();
    const a = await store("a");
    const b = await store("b");
    const c = await store("c");
    await mutate("deleteFile", { storageId: c });
    expect(await msg(mutate("deleteFiles", { storageIds: [a, b, c] }))).toContain("not found");
    expect(await query("numFiles")).toBe(2);
    expect(await msg(mutate("deleteFiles", { storageIds: [a, "no-such-file"] }))).toStartWith(
      "ArgumentValidationError:",
    );
    expect(await query("numFiles")).toBe(2);
    await mutate("deleteFiles", { storageIds: [a, b] });
    expect(await query("numFiles")).toBe(0);
  });

  test("an unknown system mutation is not found", async () => {
    const { functions } = await setup();
    expect(await msg(functions.runSystemMutation("_system/frontend/nope", {}))).toContain("Could not find");
  });
});
