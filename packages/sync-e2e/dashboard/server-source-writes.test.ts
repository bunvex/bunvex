// The Data screen's writes on the server source (STUDY-149 PR 3), against a live server in the process: the contract
// suite's `writes` area and the history opt-in, then what the contract leaves to the deployment — Convex's
// refusals and their codes, the audit events with the documents' ids, the clear's pages, a table created and
// deleted, int64 and bytes written, a patch that removes a field, a read-only key, and what `watchTable` hears.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { describeDataSourceContract } from "@bunvex/dashboard/contract";
import type { AuditEvent, DataSourceError } from "@bunvex/dashboard/data-source";
import { createServerDataSource, type ServerDataSource } from "@bunvex/dashboard-source";
import { type LiveServer, startLiveServer, until } from "./live-server.ts";

const INSTANCE = "dashboard-source-writes";
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
        export default defineSchema({
          items: defineTable(v.any()),
          strict: defineTable({ name: v.string(), n: v.optional(v.number()) }),
          scratch: defineTable(v.any()),
        });`,
    },
    {
      path: "items.js",
      source: `import { mutation } from "@bunvex/server";
        import { v } from "@bunvex/values";
        export const add = mutation({ args: { doc: v.any() }, handler: ({ db }, { doc }) => db.insert("items", doc) });`,
    },
  ]);
  for (let i = 0; i < 3; i++) await srv.call("mutation", "items:add", { doc: { label: `seed ${i}`, n: i } });
});

afterAll(async () => {
  await Promise.all(sources.map((s) => s.close()));
  srv?.stop();
});

describeDataSourceContract("@bunvex/dashboard-source on a live server (PR 3)", () => open(), {
  only: ["writes", "deploymentFeatures"],
  writes: { table: "items", clear: false },
  history: { table: "items" },
});

const codeOf = async (p: Promise<unknown>) =>
  p.then(
    () => "resolved",
    (e: DataSourceError) => `${e.code}: ${e.message}`,
  );
const latest = async (src: ServerDataSource, n = 1): Promise<AuditEvent[]> =>
  (await src.listAuditEvents!({ numItems: n, cursor: null })).page;
const allOf = async (src: ServerDataSource, table: string) =>
  (await src.listDocuments({ table, numItems: 1000, cursor: null, filter: { clauses: [], order: "asc" } })).page;

describe("the Data screen's writes, as Convex's", () => {
  test("an insert is one add_documents event with the new ids; int64 and bytes are written as such", async () => {
    const src = open();
    await src.insertDocuments!("scratch", [
      { big: { $integer: "BQAAAAAAAAA=" }, raw: { $bytes: "AQID" } },
      { nested: { a: [1, null, "x"] } },
    ]);
    const docs = await allOf(src, "scratch");
    expect(docs.slice(-2).map(({ _id, _creationTime, ...rest }) => rest)).toEqual([
      { big: { $integer: "BQAAAAAAAAA=" }, raw: { $bytes: "AQID" } },
      { nested: { a: [1, null, "x"] } },
    ]);
    const [e] = await latest(src);
    expect(e?.action).toBe("add_documents");
    expect(e?.metadata).toEqual({
      component_id: null,
      component: null,
      table: "scratch",
      document_ids: docs.slice(-2).map((d) => d._id),
    });
  });

  test("a patch sets and removes fields (the undefined placeholder) and records update_documents", async () => {
    const src = open();
    await src.insertDocuments!("scratch", [{ label: "patched", keep: 1, drop: 2 }]);
    const id = (await allOf(src, "scratch")).find((d) => d.label === "patched")!._id;
    await src.patchDocuments!("scratch", [id], { drop: { $unset: true }, added: { $integer: "AQAAAAAAAAA=" } });
    const doc = await src.getDocument("scratch", id);
    expect(doc).toMatchObject({ label: "patched", keep: 1, added: { $integer: "AQAAAAAAAAA=" } });
    expect(doc && "drop" in doc).toBe(false);
    const [e] = await latest(src);
    expect([e?.action, e?.metadata.table, e?.metadata.document_ids]).toEqual(["update_documents", "scratch", [id]]);
    // `_id` with its own value is no change; another value is refused with Convex's words
    await src.patchDocuments!("scratch", [id], { _id: id });
    expect(await codeOf(src.patchDocuments!("scratch", [id], { _creationTime: 1 }))).toMatch(
      /^invalid_request: Provided creation time/,
    );
  });

  test("the schema's refusals and a system table's are invalid_request with the deployment's words", async () => {
    const src = open();
    expect(await codeOf(src.insertDocuments!("strict", [{ name: "ok" }, { name: 1 }]))).toMatch(
      /^invalid_request: Failed to insert or update a document in table "strict" because it does not match the schema/,
    );
    expect(await allOf(src, "strict")).toEqual([]);
    expect(await codeOf(src.insertDocuments!("_storage", [{}]))).toBe(
      "invalid_request: System tables (prefixed with `_`) are read-only.",
    );
    expect(await codeOf(src.insertDocuments!("scratch", [{ _bad: 1 }]))).toMatch(
      /^invalid_request: .*Field '_bad' starts with an underscore/,
    );
    expect(
      await codeOf(
        src.insertDocuments!(
          "scratch",
          Array.from({ length: 4097 }, () => ({})),
        ),
      ),
    ).toBe("invalid_request: Can’t import more than 4096 documents at once.");
    // a declared type that refuses `{}`: Convex's createTable fails with the schema's error
    expect(await codeOf(src.createTable!("strict"))).toMatch(/^invalid_request: Failed to insert or update/);
    expect(await codeOf(src.deleteDocuments!("scratch", ["nope"]))).toMatch(
      /^invalid_request: Invalid argument `id` for `db.delete`: Unable to decode ID/,
    );
  });

  test("a document that is gone is not_found for patch, replace and delete", async () => {
    const src = open();
    await src.insertDocuments!("scratch", [{ label: "gone" }]);
    const id = (await allOf(src, "scratch")).find((d) => d.label === "gone")!._id;
    await src.deleteDocuments!("scratch", [id]);
    expect(await codeOf(src.patchDocuments!("scratch", [id], { x: 1 }))).toBe(
      "not_found: Cannot read properties of null (reading '_id')",
    );
    expect(await codeOf(src.replaceDocument!("scratch", id, {}))).toBe("not_found: Document does not exist.");
    expect(await codeOf(src.deleteDocuments!("scratch", [id]))).toBe(
      `not_found: Delete on nonexistent document ID ${id}`,
    );
  });

  test("clearTable goes page after page (4 000 each), one delete_documents event per page", async () => {
    const src = open();
    await src.createTable!("bulk");
    for (let i = 0; i < 2; i++)
      await src.insertDocuments!(
        "bulk",
        Array.from({ length: 4096 }, (_, j) => ({ j: i * 4096 + j })),
      );
    const before = (await latest(src)).at(0)?.id;
    expect(await src.clearTable!("bulk")).toEqual({ deleted: 8192 });
    const events = (await latest(src, 10)).filter((e) => e.action === "delete_documents");
    expect(events.length).toBeGreaterThanOrEqual(3);
    expect(events.slice(0, 3).map((e) => (e.metadata.document_ids as string[]).length)).toEqual([192, 4000, 4000]);
    expect(events[2]?.id).not.toBe(before);
    expect((await src.listTables()).find((t) => t.name === "bulk")?.documentCount).toBe(0);
    expect(await codeOf(src.clearTable!("nope"))).toBe('not_found: Table "nope" does not exist.');
  }, 60_000);

  test("createTable and deleteTables: the events, a declared table refused", async () => {
    const src = open();
    await src.createTable!("made");
    const [created] = await latest(src);
    expect([created?.action, created?.metadata]).toEqual([
      "create_table",
      { component_id: null, component: null, table: "made" },
    ]);
    // the table list hears it (the mapping stays subscribed)
    await until(async () => (await src.listTables()).some((t) => t.name === "made"), "the new table listed");
    await src.deleteTables!(["made"]);
    const [deleted] = await latest(src);
    expect([deleted?.action, deleted?.metadata.table_names]).toEqual(["delete_tables", ["made"]]);
    // a name with no table is skipped, as Convex's route
    await src.deleteTables!(["never_made"]);
    expect(await codeOf(src.deleteTables!(["strict"]))).toBe(
      'invalid_request: Failed to delete table "strict" because it appears in the schema',
    );
  });

  test("watchTable hears an insert into the table, with its count", async () => {
    const src = open();
    const counts: (number | undefined)[] = [];
    const off = src.watchTable(
      "scratch",
      (c) => counts.push(c.count),
      () => {},
    );
    await Bun.sleep(100);
    const before = (await src.listTables()).find((t) => t.name === "scratch")?.documentCount ?? 0;
    await src.insertDocuments!("scratch", [{ label: "heard" }]);
    await until(() => counts.includes(before + 1), "the insert's count");
    off();
  });

  test("a read-only key may not write: unauthorized, nothing written", async () => {
    const src = open(srv.readOnlyKey);
    const before = (await open().listTables()).find((t) => t.name === "items")!.documentCount;
    expect(await codeOf(src.insertDocuments!("items", [{ a: 1 }]))).toMatch(/^unauthorized:/);
    expect(await codeOf(src.createTable!("ro_table"))).toMatch(/^unauthorized:/);
    expect(await codeOf(src.deleteTables!(["items"]))).toMatch(/^unauthorized:/);
    expect((await open().listTables()).find((t) => t.name === "items")!.documentCount).toBe(before);
  });
});
