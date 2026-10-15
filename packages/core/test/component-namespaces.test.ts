// Tables of components (STUDY-152 step 1): each component's tables are in their own namespace, numbered from 10001
// as the root's, with the same system tables at the same numbers. The store is built with bunvex's own catalog API
// as Convex lays one out (component-store.ts; convex-rows/components.json holds Convex's rows): a root with
// `messages`, and a `counter` component mounted twice (`counter`, `second`), each with `counters` (10001) and
// `messages` (10002). A store the Convex binary itself wrote is opened in packages/differential.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { v } from "@bunvex/values";
import {
  activeTables,
  buildCatalog,
  databaseIndexRows,
  type IndexMeta,
  indexStatePatch,
  planCatalog,
  type TableMeta,
  tableMeta,
  tableRow,
} from "../src/catalog.ts";
import { Engine } from "../src/engine.ts";
import type { IndexId, TabletId } from "../src/persistence/index.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import { TABLE_SUMMARY_GLOBAL } from "../src/table-summary-checkpoint.ts";
import { buildComponentStore, rootSchema } from "./component-store.ts";
import { shapeDiff, stored } from "./convex-rows/shape.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
/** A fresh store with components (component-store.ts); its path. */
async function componentStore(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "bunvex-components-"));
  dirs.push(dir);
  return (await buildComponentStore(join(dir, "log"))).path;
}
const open = async (path: string) =>
  await new Engine(rootSchema, await MemoryPersistence.open(path, { durable: false })).init();
/** Convex's rows (convex-rows/components.json). */
const convex = JSON.parse(readFileSync(join(import.meta.dir, "convex-rows/components.json"), "utf8")) as {
  componentTableRow: Record<string, unknown>;
  componentNamespace: Record<string, { number: number; indexes: Record<string, string[]> }>;
};

/** The per-namespace system tables Convex creates for a component, at its numbers. */
const COMPONENT_SYSTEM_TABLES = Object.fromEntries(
  Object.entries(convex.componentNamespace).map(([name, t]) => [name, t.number]),
);

describe("a store with components", () => {
  test("the root's tables are the root's: a component's table of the same name and number is apart", async () => {
    const e = await open(await componentStore());
    try {
      const docs = await e.query((db) => db.query("messages").collect());
      expect(docs.map((d) => d.text)).toEqual(["root"]);
      expect(e.catalog.table("messages").number).toBe(10001);
      expect(e.catalog.tables.has("counters")).toBe(false);
      // The root's system tables are its own: a component's `_modules` is another table.
      for (const c of e.catalog.components.values())
        expect(c.table("_modules").id).not.toBe(e.catalog.table("_modules").id);
    } finally {
      await e.close();
    }
  });

  test("each component's tables are in its own namespace, with Convex's numbers", async () => {
    const e = await open(await componentStore());
    try {
      expect(e.catalog.components.size).toBe(2);
      for (const c of e.catalog.components.values()) {
        const numbers = Object.fromEntries([...c.tables.values()].map((t) => [t.name, t.number]));
        expect(numbers).toEqual({ ...COMPONENT_SYSTEM_TABLES, counters: 10001, messages: 10002 });
        // Found by tablet from the root, not by name or number.
        const messages = c.table("messages");
        expect(e.catalog.anyTablet(messages.id)).toBe(messages);
        expect(e.catalog.byTablet(messages.id)).toBeUndefined();
        expect(messages.indexes.get("by_n")?.fields).toEqual(["n", "_creationTime"]);
      }
    } finally {
      await e.close();
    }
  });

  test("the root keeps working: writes, and a new table numbered among the root's alone", async () => {
    const path = await componentStore();
    const e = await open(path);
    try {
      await e.mutation((db) => db.insert("messages", { text: "after" }));
      await e.mutation((db) => db.insert("made", { a: 1 }));
      // 10002 is free in the root, though both components have a 10002.
      expect(e.catalog.table("made").number).toBe(10002);
      expect((await e.query((db) => db.query("messages").collect())).map((d) => d.text)).toEqual(["root", "after"]);
    } finally {
      await e.close();
    }
    // And again after a restart: the components are still apart.
    const again = await open(path);
    try {
      expect(again.catalog.components.size).toBe(2);
      expect((await again.query((db) => db.query("messages").collect())).length).toBe(2);
    } finally {
      await again.close();
    }
  });

  test("a component's _tables row: Convex's shape, its namespace read and written back", async () => {
    const e = await open(await componentStore());
    try {
      const rows = (await e.query((db) => db.asSystem(() => db.query("_tables").collect()))) as Record<
        string,
        unknown
      >[];
      const row = rows.find((r) => r.name === "counters")!;
      const meta = tableMeta(row);
      expect(meta.namespace).toBe((row.namespace as { id: string }).id);
      expect(e.catalog.components.has(meta.namespace!)).toBe(true);
      // bunvex writes it as Convex does: `{kind: "byComponent", id}`, int64 number.
      const written = tableRow(meta);
      expect(written).toEqual({
        name: "counters",
        number: 10001n,
        state: "active",
        namespace: row.namespace as { kind: string; id: string },
      });
      // Convex's row of a component's table, and the same shape written by bunvex.
      const { _id: _, _creationTime: __, ...convexRow } = convex.componentTableRow;
      expect(shapeDiff(stored(written), convexRow)).toEqual([]);
      expect((convexRow.namespace as { kind: string }).kind).toBe("byComponent");
      // A root table's row has no namespace at all.
      expect("namespace" in tableRow({ name: "messages", number: 10001, state: "active" })).toBe(false);
    } finally {
      await e.close();
    }
  });
});

describe("the catalog by namespace", () => {
  const tablet = (n: number) => `t${n}` as TabletId;
  const table = (n: number, name: string, number: number, namespace?: string): TableMeta => {
    const t: TableMeta = { _id: `id${n}`, name, number, tablet: tablet(n), state: "active" };
    if (namespace !== undefined) t.namespace = namespace;
    return t;
  };
  const byId = (n: number): IndexMeta => ({
    _id: `ix${n}`,
    indexId: `i${n}` as IndexId,
    tablet: tablet(n),
    name: "by_id",
    fields: ["_id"],
    state: "enabled",
    persistenceIndexId: n,
  });
  const tables = [table(1, "messages", 10001), table(2, "messages", 10001, "c1"), table(3, "other", 10002, "c1")];
  const indexes = tables.map((_, i) => byId(i + 1));

  test("buildCatalog keeps a component's tables out of the root's names and numbers", () => {
    const c = buildCatalog(tables, indexes);
    expect(c.table("messages").id).toBe(tablet(1));
    expect(c.byNumber(10001)?.id).toBe(tablet(1));
    expect(c.byNumber(10002)).toBeUndefined();
    const c1 = c.components.get("c1")!;
    expect(c1.table("messages").id).toBe(tablet(2));
    expect(c1.byNumber(10002)?.name).toBe("other");
    expect(c.anyTablet(tablet(3))?.name).toBe("other");
    expect(c.anyTablet("nope" as TabletId)).toBeUndefined();
  });

  test("activeTables finds names in one namespace", () => {
    expect(activeTables(tables).map((t) => t.tablet)).toEqual([tablet(1)]);
    expect(activeTables(tables, "c1").map((t) => t.tablet)).toEqual([tablet(2), tablet(3)]);
  });

  test("planCatalog numbers a root table among the root's, and the table cap counts every namespace", () => {
    const plan = planCatalog([{ name: "made", indexes: {}, document: v.any() }], tables, indexes);
    expect(plan.insertTables).toEqual([{ name: "made", number: 10002, state: "active" }]);
    // A declared table the root lacks is new, though a component has one of that name.
    const other = planCatalog([{ name: "other", indexes: {}, document: v.any() }], tables, indexes);
    expect(other.insertTables.map((t) => t.name)).toEqual(["other"]);
    const many = Array.from({ length: 9_997 }, (_, i) => table(100 + i, `t${i}`, 10_010 + i));
    // 1 root + 2 component user tables + 9 997: one more than 10 000.
    expect(() =>
      planCatalog(
        [
          { name: "x", indexes: {}, document: v.any() },
          { name: "y", indexes: {}, document: v.any() },
        ],
        [...tables, ...many],
        indexes,
      ),
    ).toThrow("Number of tables cannot exceed 10000.");
  });

  test("index state changes reach a component's tables; table state changes keep the components", () => {
    const pending: IndexMeta = {
      ...byId(9),
      _id: "ix9",
      indexId: "i9" as IndexId,
      tablet: tablet(2),
      name: "by_x",
      fields: ["x"],
      state: "backfilled",
    };
    const c = buildCatalog(tables, [...indexes, pending]);
    expect(
      c.components
        .get("c1")!
        .table("messages")
        .pending.map((i) => i.name),
    ).toEqual(["by_x"]);
    const enabled = c.withIndexChanges({ enable: ["i9" as IndexId], disable: [], drop: [] }, 5n);
    expect(enabled.components.get("c1")!.table("messages").indexes.get("by_x")?.readyTs).toBe(5n);
    expect(c.withTableStates({}).components.get("c1")).toBe(c.components.get("c1"));
  });
});

describe("the engine's workers by namespace", () => {
  test("table summaries count a component's tables, and their checkpoint has them (Convex loads it)", async () => {
    const p = await MemoryPersistence.open(await componentStore(), { durable: false });
    const e = await new Engine(rootSchema, p).init();
    try {
      await (e as unknown as { summariesBuild: Promise<void> }).summariesBuild;
      const counter = [...e.catalog.components.values()][0]!;
      expect(e.tableSummaries.count(counter.table("messages").id)).toBe(1);
      expect(e.catalog.everyTable().map((t) => t.id)).toContain(counter.table("counters").id);
      await e.summaryCheckpointer!.tick(true);
      const checkpoint = (await p.getGlobal(TABLE_SUMMARY_GLOBAL)) as { tables: Record<string, unknown> };
      for (const t of counter.tables.values()) expect(Object.keys(checkpoint.tables)).toContain(t.id);
    } finally {
      await e.close();
    }
  });

  test("stale hidden tables are dropped from the root only: a component's hidden table stays", async () => {
    const e = await open(await componentStore());
    try {
      await e.mutation((db) =>
        db.asSystem(async () => {
          const row = (await db.query("_tables").collect()).find((r) => r.name === "counters")!;
          await db.patch("_tables", row._id as string, { state: "hidden" });
        }),
      );
      expect(await e.dropStaleHiddenTables(0, Date.now() + 1000)).toBe(0);
    } finally {
      await e.close();
    }
  });

  test("retention prunes a component's index entries: it is given that table's indexes", async () => {
    const e = await open(await componentStore());
    try {
      const messages = [...e.catalog.components.values()][0]!.table("messages");
      // The indexes retention prunes for a tablet (Convex's `expired_index_entries`): a component's too.
      const indexesOf = (e.retention as unknown as { indexesOf(t: TabletId): { name: string }[] }).indexesOf;
      expect(
        indexesOf(messages.id)
          .map((i) => i.name)
          .sort(),
      ).toEqual(["by_creation_time", "by_id", "by_n"]);
    } finally {
      await e.close();
    }
  });

  test("a component's index left backfilling is backfilled and enabled", async () => {
    const path = await componentStore();
    const first = await open(path);
    let indexDocId = "";
    try {
      await first.mutation((db) =>
        db.asSystem(async () => {
          const tables = (await db.query("_tables").collect()).map(tableMeta);
          const counters = tables.filter((t) => t.name === "messages" && t.namespace !== undefined);
          const rows = (await db.query("_index").collect()) as Record<string, unknown>[];
          for (const m of databaseIndexRows(rows))
            if (m.tablet === counters[0]!.tablet && m.name === "by_n") {
              indexDocId = m._id;
              await db.patch("_index", m._id, indexStatePatch(m, { state: "backfilling" }));
            }
        }),
      );
    } finally {
      await first.close();
    }
    expect(indexDocId).not.toBe("");
    const e = await open(path);
    try {
      await e.indexesReady();
      const rows = (await e.query((db) => db.asSystem(() => db.query("_index").collect()))) as Record<
        string,
        unknown
      >[];
      const m = databaseIndexRows(rows).find((r) => r._id === indexDocId)!;
      expect(m.state).not.toBe("backfilling");
    } finally {
      await e.close();
    }
  });
});
