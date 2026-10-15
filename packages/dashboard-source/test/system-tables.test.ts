// The system tables (STUDY-131 AD-24) over a fake connection: what the two debug queries are asked, the listing
// sorted, a page's documents in the contract's JSON, and the refusals the server does not make itself (a user
// table's name, a bad page size, a system table the catalog lacks, which the server reads as empty).
import { describe, expect, test } from "bun:test";
import { DataSourceError } from "@bunvex/dashboard/data-source";
import type { AdminSync } from "../src/sync.ts";
import { SystemTables } from "../src/system-tables.ts";

type Call = { path: string; args: Record<string, unknown> };

const ROWS = [
  { name: "_tables", description: "Every table.", appVisible: false, documentCount: 4 },
  { name: "_storage", description: "Files.", appVisible: true, documentCount: null },
  { name: "_index", description: "Every index.", appVisible: false, documentCount: 2 },
];

/** The system tables over a fake connection: each query answers `answer(call)` (an Error is a failure). */
function fake(answer: (c: Call) => unknown) {
  const calls: Call[] = [];
  const sync = {
    query: async (path: string, args: Record<string, unknown>) => {
      calls.push({ path, args });
      const r = answer({ path, args });
      if (r instanceof Error) throw r;
      return r;
    },
  } as unknown as AdminSync;
  return { tables: new SystemTables(sync), calls };
}

const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return (e as DataSourceError).code;
  }
  return "resolved";
};

describe("listSystemTables", () => {
  test("the debug listing, sorted by name, every field kept", async () => {
    const { tables, calls } = fake(() => ROWS);
    expect(await tables.listSystemTables()).toEqual([
      { name: "_index", description: "Every index.", appVisible: false, documentCount: 2 },
      { name: "_storage", description: "Files.", appVisible: true, documentCount: null },
      { name: "_tables", description: "Every table.", appVisible: false, documentCount: 4 },
    ]);
    expect(calls).toEqual([{ path: "_system/debug/systemTables", args: {} }]);
  });

  test("a refusal keeps its code", async () => {
    const { tables } = fake(() => new DataSourceError("unauthorized", "no"));
    expect(await code(tables.listSystemTables())).toBe("unauthorized");
  });
});

describe("listSystemDocuments", () => {
  const page = {
    page: [{ _id: "a", _creationTime: 1, n: 5n, b: new Uint8Array([1, 2]).buffer }],
    isDone: false,
    continueCursor: "c1",
  };
  const answer = (c: Call) => (c.path === "_system/debug/systemTables" ? ROWS : page);

  test("asks the page with the order (oldest first by default) and the cursor; int64 and bytes as JSON", async () => {
    const { tables, calls } = fake(answer);
    const p = await tables.listSystemDocuments({ table: "_tables", numItems: 2, cursor: null });
    expect(p).toEqual({
      page: [{ _id: "a", _creationTime: 1, n: { $integer: "BQAAAAAAAAA=" }, b: { $bytes: "AQI=" } }],
      isDone: false,
      continueCursor: "c1",
    });
    await tables.listSystemDocuments({ table: "_index", numItems: 5, cursor: "c1", order: "desc" });
    expect(calls.filter((c) => c.path === "_system/debug/systemTable").map((c) => c.args)).toEqual([
      { table: "_tables", order: "asc", paginationOpts: { numItems: 2, cursor: null } },
      { table: "_index", order: "desc", paginationOpts: { numItems: 5, cursor: "c1" } },
    ]);
  });

  test("a user table's name and a bad page size: invalid_request, nothing sent", async () => {
    const { tables, calls } = fake(answer);
    expect(await code(tables.listSystemDocuments({ table: "messages", numItems: 1, cursor: null }))).toBe(
      "invalid_request",
    );
    for (const numItems of [0, -1, 1.5])
      expect(await code(tables.listSystemDocuments({ table: "_tables", numItems, cursor: null }))).toBe(
        "invalid_request",
      );
    expect(calls).toEqual([]);
  });

  test("a system table the deployment lacks: not_found (the server reads it as empty)", async () => {
    const { tables } = fake((c) =>
      c.path === "_system/debug/systemTables" ? ROWS : { page: [], isDone: true, continueCursor: "" },
    );
    expect(await code(tables.listSystemDocuments({ table: "_nope", numItems: 1, cursor: null }))).toBe("not_found");
  });

  test("a cursor the server refuses: invalid_request; a permission refusal: unauthorized", async () => {
    const cursor = fake((c) =>
      c.path === "_system/debug/systemTables"
        ? ROWS
        : new DataSourceError("unavailable", "_system/debug/systemTable: InvalidCursor: Failed to parse cursor"),
    );
    expect(await code(cursor.tables.listSystemDocuments({ table: "_tables", numItems: 1, cursor: "x" }))).toBe(
      "invalid_request",
    );
    const denied = fake(() => new DataSourceError("unauthorized", "no"));
    expect(await code(denied.tables.listSystemDocuments({ table: "_tables", numItems: 1, cursor: null }))).toBe(
      "unauthorized",
    );
  });
});
