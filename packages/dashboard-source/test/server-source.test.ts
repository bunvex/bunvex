// The server source's own mappings (STUDY-149 §3.3), where no live server is needed: the schema.
import { describe, expect, test } from "bun:test";
import type { AdminHttp } from "../src/admin-http.ts";
import { componentsOf, schemaInfoOf } from "../src/server-source.ts";
import type { AdminSync } from "../src/sync.ts";
import { Tables } from "../src/tables.ts";

const NONE = { database: [], search: [], vector: [] };

describe("schemaInfoOf", () => {
  test("declared tables with their document types; v.any() and no validator alike; enforcement and progress", () => {
    const json = JSON.stringify({
      tables: [
        { tableName: "messages", documentType: { type: "object", value: {} }, indexes: [] },
        { tableName: "loose", documentType: { type: "any" }, indexes: [] },
        { tableName: "bare", documentType: null, indexes: [] },
      ],
      schemaValidation: false,
    });
    expect(schemaInfoOf(json, { state: "validating", numDocsValidated: 1, totalDocs: null })).toEqual({
      enforced: false,
      tables: [
        { name: "messages", validator: { type: "object", value: {} }, indexes: NONE },
        { name: "loose", indexes: NONE },
        { name: "bare", indexes: NONE },
      ],
      validation: { state: "validating", numDocsValidated: 1, totalDocs: null },
    });
  });

  test("the declared indexes of every kind, staged ones marked (STUDY-162 §8)", () => {
    const json = JSON.stringify({
      tables: [
        {
          tableName: "docs",
          documentType: null,
          indexes: [{ indexDescriptor: "by_a", fields: ["a"] }],
          stagedDbIndexes: [{ indexDescriptor: "by_b", fields: ["b", "c"] }],
          searchIndexes: [{ indexDescriptor: "search_t", searchField: "t", filterFields: ["a"] }],
          stagedSearchIndexes: [{ indexDescriptor: "search_u", searchField: "u", filterFields: [] }],
          vectorIndexes: [{ indexDescriptor: "by_e", vectorField: "e", dimensions: 3, filterFields: [] }],
        },
      ],
      schemaValidation: true,
    });
    expect(schemaInfoOf(json, undefined).tables[0]!.indexes).toEqual({
      database: [
        { name: "by_a", fields: ["a"], staged: false },
        { name: "by_b", fields: ["b", "c"], staged: true },
      ],
      search: [
        { name: "search_t", searchField: "t", filterFields: ["a"], staged: false },
        { name: "search_u", searchField: "u", filterFields: [], staged: true },
      ],
      vector: [{ name: "by_e", vectorField: "e", dimensions: 3, filterFields: [], staged: false }],
    });
  });

  test("no schema pushed: nothing declared, not enforced", () => {
    expect(schemaInfoOf(undefined, undefined)).toEqual({ enforced: false, tables: [] });
  });
});

describe("components (STUDY-152 §4)", () => {
  test('the list without the app (path ""), each with its name, path and state', () => {
    expect(
      componentsOf([
        { id: "root", name: null, path: "", state: "active" },
        { id: "c1", name: "counter", path: "counter", state: "active" },
        { id: "c2", name: "inner", path: "counter/inner" },
        { id: "c3", name: "old", path: "old", state: "unmounted" },
      ]),
    ).toEqual([
      { id: "c1", name: "counter", path: "counter", state: "active" },
      { id: "c2", name: "inner", path: "counter/inner", state: "active" },
      { id: "c3", name: "old", path: "old", state: "unmounted" },
    ]);
  });

  test("a component's tables pass its componentId (its indexes, its tableNamespace), as Convex's Data screen", async () => {
    const calls: { path: string; args: Record<string, unknown> }[] = [];
    const answers: Record<string, unknown> = {
      "_system/frontend/getTableMapping": { "10001": "counts" },
      "_system/frontend/getSchemas": {},
      "_system/frontend/indexes": [],
      "_system/frontend/tableSize": 2,
      "_system/frontend/paginatedTableDocuments": { page: [], isDone: true, continueCursor: "" },
    };
    const sync = {
      query: async (path: string, args: Record<string, unknown>) => {
        calls.push({ path, args });
        return answers[path];
      },
      watch: (path: string, args: Record<string, unknown>, cb: (r: unknown) => void) => {
        calls.push({ path, args });
        setTimeout(() => cb({ success: true, value: answers[path], logLines: [] }), 0);
        return () => {};
      },
    } as unknown as AdminSync;
    const t = new Tables(sync, {} as AdminHttp, Date.now, "c1");
    await t.listTables();
    await t.listDocuments({ table: "counts", numItems: 10, cursor: null });
    t.close();
    for (const c of calls)
      if (c.path === "_system/frontend/indexes") expect(c.args.tableNamespace).toBe("c1");
      else expect(c.args.componentId).toBe("c1");
    expect(new Set(calls.map((c) => c.path)).size).toBe(5);
  });
});
