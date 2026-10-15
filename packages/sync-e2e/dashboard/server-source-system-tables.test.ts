// The system tables on a deployment (STUDY-131 AD-24, wired in @bunvex/dashboard-source): the contract suite's
// system-tables area against a live bunvex server in this process, then what the contract leaves open — the
// listing is the server's catalog (descriptions, sizes, which ones apps read), a private table's documents as
// stored (an index the app declared, in `_index`, paged in id order), a file's stored fields in `_file_storage`,
// a system table the deployment lacks and a user table's name refused, and a read-only key.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { describeDataSourceContract } from "@bunvex/dashboard/contract";
import type { DataSourceError, Document } from "@bunvex/dashboard/data-source";
import { createServerDataSource, type ServerDataSource } from "@bunvex/dashboard-source";
import { type LiveServer, startLiveServer } from "./live-server.ts";

const INSTANCE = "dashboard-source-system-tables";
let srv: LiveServer;
const sources: ServerDataSource[] = [];
const open = (adminKey = srv.adminKey) => {
  const s = createServerDataSource({ url: srv.url, adminKey });
  sources.push(s);
  return s;
};

beforeAll(async () => {
  srv = await startLiveServer(INSTANCE, [
    {
      path: "schema.js",
      source: `import { defineSchema, defineTable } from "@bunvex/server";
        import { v } from "@bunvex/values";
        export default defineSchema({ messages: defineTable({ body: v.string() }).index("by_body", ["body"]) });`,
    },
    {
      path: "messages.js",
      source: `import { mutation } from "@bunvex/server";
        import { v } from "@bunvex/values";
        export const send = mutation({ args: { body: v.string() }, handler: async ({ db }, { body }) => {
          await db.insert("messages", { body });
        } });`,
    },
  ]);
  await srv.call("mutation", "messages:send", { body: "hello" });
  await open().uploadFile!(new Blob(["a file"], { type: "text/plain" }));
});

afterAll(async () => {
  await Promise.all(sources.map((s) => s.close()));
  srv?.stop();
});

describeDataSourceContract("@bunvex/dashboard-source on a live server (system tables)", () => open(), {
  only: ["systemTables"],
});

const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return (e as DataSourceError).code;
  }
  return "resolved";
};

/** Every document of a system table, oldest first. */
async function all(src: ServerDataSource, table: string) {
  const docs: Document[] = [];
  let cursor: string | null = null;
  for (;;) {
    const p = await src.listSystemDocuments!({ table, numItems: 50, cursor });
    docs.push(...p.page);
    if (p.isDone) return docs;
    cursor = p.continueCursor;
  }
}

describe("system tables on a live server", () => {
  test("the listing is the server's catalog: private and app-readable tables, descriptions, sizes", async () => {
    const src = open();
    const tables = await src.listSystemTables!();
    const byName = new Map(tables.map((t) => [t.name, t]));
    for (const name of ["_tables", "_index", "_file_storage", "_schemas"]) expect(byName.has(name)).toBe(true);
    expect(byName.get("_tables")!.appVisible).toBe(false);
    expect(byName.get("_tables")!.description).not.toBe("");
    expect(byName.has("messages")).toBe(false);
    // the size is the table's: `_tables` counted as the pages walk it
    expect(byName.get("_tables")!.documentCount).toBe((await all(src, "_tables")).length);
  });

  test("a private table's documents as stored: the app's table in `_tables`, its index in `_index`", async () => {
    const src = open();
    const tables = await all(src, "_tables");
    expect(tables.some((d) => d.name === "messages")).toBe(true);
    const indexes = JSON.stringify(await all(src, "_index"));
    expect(indexes).toContain("by_body");
  });

  test("`_file_storage` (apps read it as `_storage`): a file's document as stored, its storage key included", async () => {
    const src = open();
    const info = (await src.listSystemTables!()).find((t) => t.name === "_file_storage")!;
    expect(info).toMatchObject({ appVisible: true, documentCount: 1 });
    // `_scheduled_jobs` is the other table apps read (as `_scheduled_functions`); every other one is private
    expect((await src.listSystemTables!()).filter((t) => t.appVisible).map((t) => t.name)).toEqual([
      "_file_storage",
      "_scheduled_jobs",
    ]);
    const [file] = await all(src, "_file_storage");
    // the contract's JSON: the size an int64, the digest bytes
    expect(file).toMatchObject({ size: { $integer: "BgAAAAAAAAA=" }, contentType: "text/plain;charset=utf-8" });
    expect(Object.keys(file!.sha256 as object)).toEqual(["$bytes"]);
    // as stored, not `db.system`'s projection: the storage key is there
    expect(typeof file!.storageKey).toBe("string");
  });

  test("`_index` has no creation-time index (as Convex's): its pages walk it once, in id order, either way", async () => {
    const src = open();
    const walk = async (order: "asc" | "desc") => {
      const ids: string[] = [];
      let cursor: string | null = null;
      for (;;) {
        const p = await src.listSystemDocuments!({ table: "_index", numItems: 7, cursor, order });
        ids.push(...p.page.map((d) => d._id));
        if (p.isDone) return ids;
        cursor = p.continueCursor;
      }
    };
    const asc = await walk("asc");
    expect(new Set(asc).size).toBe(asc.length);
    expect(asc).toEqual([...asc].sort());
    expect(await walk("desc")).toEqual([...asc].reverse());
  });

  test("refused: a user table's name, a system table the deployment lacks, a cursor of nothing", async () => {
    const src = open();
    expect(await code(src.listSystemDocuments!({ table: "messages", numItems: 1, cursor: null }))).toBe(
      "invalid_request",
    );
    expect(await code(src.listSystemDocuments!({ table: "_nope", numItems: 1, cursor: null }))).toBe("not_found");
    expect(await code(src.listSystemDocuments!({ table: "_tables", numItems: 1, cursor: "not a cursor" }))).toBe(
      "invalid_request",
    );
  });

  test("a read-only key may read them (ViewData)", async () => {
    const src = open(srv.readOnlyKey);
    expect((await src.listSystemTables!()).length).toBeGreaterThan(0);
    expect((await src.listSystemDocuments!({ table: "_tables", numItems: 1, cursor: null })).page.length).toBe(1);
  });
});
