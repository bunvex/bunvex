// The contract suite's part for the system tables (STUDY-131 AD-24, data-source-system-tables.ts). Read-only,
// so it runs whenever the source offers the view: system names only, sorted; pages that walk a table once in
// either order; a user table's name and a bad page size refused; `unauthorized` without `viewData`.
import { expect } from "bun:test";
import type { DashboardDataSource, DataSourceError, Document } from "./data-source.ts";

type Ctx = {
  make: () => DashboardDataSource | Promise<DashboardDataSource>;
  test: (name: string, fn: () => Promise<void>) => void;
};

const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return (e as DataSourceError).code;
  }
  return "resolved";
};

export function describeSystemTablesContract({ make, test }: Ctx) {
  test("system tables (when offered): `_` names, sorted, each with a description and a count", async () => {
    const src = await make();
    if (!src.listSystemTables) return;
    if (!(await src.getCapabilities()).operations.includes("viewData")) {
      expect(await refusal(src.listSystemTables())).toBe("unauthorized");
      return;
    }
    const tables = await src.listSystemTables();
    expect(tables.length).toBeGreaterThan(0);
    expect(tables.every((t) => t.name.startsWith("_"))).toBe(true);
    expect(tables.map((t) => t.name)).toEqual(tables.map((t) => t.name).sort());
    for (const t of tables) {
      expect(typeof t.description).toBe("string");
      expect(t.documentCount === null || t.documentCount >= 0).toBe(true);
    }
    // the user tables are not among them
    const user = new Set((await src.listTables()).map((t) => t.name));
    expect(tables.some((t) => user.has(t.name))).toBe(false);
  });

  test("system tables (when offered): pages walk a table once, either order; refusals", async () => {
    const src = await make();
    if (!src.listSystemTables || !src.listSystemDocuments) return;
    if (!(await src.getCapabilities()).operations.includes("viewData")) {
      expect(await refusal(src.listSystemDocuments({ table: "_tables", numItems: 1, cursor: null }))).toBe(
        "unauthorized",
      );
      return;
    }
    const tables = await src.listSystemTables();
    const table = tables.find((t) => (t.documentCount ?? 0) > 1)?.name ?? tables[0]!.name;
    const walk = async (order: "asc" | "desc") => {
      const seen: Document[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 1000; i++) {
        const p = await src.listSystemDocuments!({ table, numItems: 2, cursor, order });
        seen.push(...p.page);
        if (p.isDone) break;
        cursor = p.continueCursor;
      }
      return seen;
    };
    const asc = await walk("asc");
    expect(new Set(asc.map((d) => d._id)).size).toBe(asc.length);
    expect(asc.every((d, i) => i === 0 || d._creationTime >= asc[i - 1]!._creationTime)).toBe(true);
    expect((await walk("desc")).map((d) => d._id)).toEqual(asc.map((d) => d._id).reverse());
    const user = (await src.listTables())[0]?.name;
    if (user)
      expect(await refusal(src.listSystemDocuments({ table: user, numItems: 1, cursor: null }))).toBe(
        "invalid_request",
      );
    expect(await refusal(src.listSystemDocuments({ table, numItems: 0, cursor: null }))).toBe("invalid_request");
  });
}
