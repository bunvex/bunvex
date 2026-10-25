// A transaction in a component's namespace (STUDY-153 PR 2): `db.inComponent(id, fn)` resolves table names and id
// numbers in that component's namespace, as Convex's per-namespace `TableModel` / `UserFacingModel`, while the read
// and write sets stay the transaction's. The store is component-store.ts's: a root with `messages` ({text}), and a
// `counter` component mounted twice (`counter`, `second`), each with `counters` (10001) and `messages` (10002).
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeId } from "@bunvex/values";
import { tableMeta } from "../src/catalog.ts";
import { Engine } from "../src/engine.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import { buildComponentStore, type ComponentStore, rootSchema } from "./component-store.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
async function store(): Promise<ComponentStore> {
  const dir = mkdtempSync(join(tmpdir(), "bunvex-component-tx-"));
  dirs.push(dir);
  return await buildComponentStore(join(dir, "log"));
}
const open = async (path: string) =>
  await new Engine(rootSchema, await MemoryPersistence.open(path, { durable: false })).init();

describe("inComponent", () => {
  test("a query reads the component's table of that name; the root's and the other instance's are apart", async () => {
    const s = await store();
    const e = await open(s.path);
    try {
      const bodies = await e.query(async (db) => ({
        root: (await db.query("messages").collect()).map((d) => d.text),
        counter: (await db.inComponent(s.ids.counter, () => db.query("messages").collect())).map((d) => d.body),
        second: (await db.inComponent(s.ids.second, () => db.query("messages").collect())).map((d) => d.body),
        counters: (await db.inComponent(s.ids.counter, () => db.query("counters").collect())).map((d) => d.name),
      }));
      expect(bodies).toEqual({
        root: ["root"],
        counter: ["in counter"],
        second: ["in second"],
        counters: ["in counter"],
      });
      // The root has no `counters`: outside the component, the name resolves to nothing.
      expect(await e.query((db) => db.query("counters").collect())).toEqual([]);
    } finally {
      await e.close();
    }
  });

  test("an insert gets the namespace's table number, is checked against no root schema, and the root sees nothing", async () => {
    const s = await store();
    const e = await open(s.path);
    try {
      // The root's `messages` requires `text`: a component's `messages` is not the root's table.
      const id = await e.mutation((db) => db.inComponent(s.ids.counter, () => db.insert("messages", { body: "x" })));
      expect(decodeId(id).tableNumber).toBe(10002);
      expect(
        await e.mutation((db) => db.insert("messages", { body: "x" }).catch((err: Error) => err.message)),
      ).toContain('Failed to insert or update a document in table "messages" because it does not match the schema');
      const read = await e.query(async (db) => ({
        inside: await db.inComponent(s.ids.counter, () => db.get(id)),
        insideTwoArgs: await db.inComponent(s.ids.counter, () => db.get("messages", id)),
        otherInstance: await db.inComponent(s.ids.second, () => db.get("messages", id)),
        root: await db.get(id),
        normalized: await db.inComponent(s.ids.counter, async () => db.normalizeId("messages", id)),
        normalizedInRoot: db.normalizeId("messages", id),
      }));
      expect(read.inside).toMatchObject({ body: "x" });
      expect(read.insideTwoArgs).toMatchObject({ body: "x" });
      // The same number names `messages` in `second` too, but the document is `counter`'s.
      expect(read.otherInstance).toBeNull();
      // 10002 names no root table.
      expect(read.root).toBeNull();
      expect(read.normalized).toBe(id);
      expect(read.normalizedInRoot).toBeNull();
    } finally {
      await e.close();
    }
  });

  test("system tables: a component's own (`_modules`) are its namespace's; the global ones (`_components`) the root's", async () => {
    const s = await store();
    const e = await open(s.path);
    try {
      const [rootModules, counterModules, components] = await e.query((db) =>
        db.asSystem(async () => [
          db.newId("_modules"),
          await db.inComponent(s.ids.counter, async () => {
            expect(db.hasTable("_modules")).toBe(true);
            expect(db.systemTableNames()).not.toContain("_components");
            return db.newId("_modules");
          }),
          await db.inComponent(s.ids.counter, () => db.query("_components").collect()),
        ]),
      );
      // The same number in each namespace (Convex's), and `_components` found from inside the component.
      expect(decodeId(rootModules as string).tableNumber).toBe(decodeId(counterModules as string).tableNumber);
      expect((components as unknown[]).length).toBe(3);
      // Each namespace's `_modules` is its own table.
      expect(e.catalog.components.get(s.ids.counter)!.table("_modules").id).not.toBe(e.catalog.table("_modules").id);
    } finally {
      await e.close();
    }
  });

  test("a table created in a component is numbered and kept in its namespace, after the commit and a restart", async () => {
    const s = await store();
    let e = await open(s.path);
    try {
      const id = await e.mutation((db) => db.inComponent(s.ids.counter, () => db.insert("notes", { n: 1 })));
      // After `counters` (10001) and `messages` (10002), in the component's namespace; the root has 10001 only.
      expect(decodeId(id).tableNumber).toBe(10003);
      const check = (engine: Engine) => {
        const notes = engine.catalog.components.get(s.ids.counter)!.table("notes");
        expect(notes).toMatchObject({ number: 10003, namespace: s.ids.counter });
        expect(engine.catalog.components.get(s.ids.second)!.tables.has("notes")).toBe(false);
      };
      check(e);
      expect(e.catalog.tables.has("notes")).toBe(false);
      expect(await e.query((db) => db.inComponent(s.ids.counter, () => db.query("notes").collect()))).toHaveLength(1);
      // Its `_tables` row names the namespace.
      const row = await e.query((db) =>
        db.asSystem(async () => (await db.query("_tables").collect()).map(tableMeta).find((t) => t.name === "notes")),
      );
      expect(row?.namespace).toBe(s.ids.counter);
      // A root table of the same name is another table, numbered among the root's.
      const rootId = await e.mutation((db) => db.insert("notes", { n: 2 }));
      expect(decodeId(rootId).tableNumber).toBe(10002);
      await e.close();
      e = await open(s.path);
      check(e);
      expect(e.catalog.table("notes").number).toBe(10002);
      expect(await e.query((db) => db.query("notes").collect())).toEqual([expect.objectContaining({ n: 2 })]);
    } finally {
      await e.close();
    }
  });

  test("one transaction creates a table of one name in a component and in the root: two tables", async () => {
    const s = await store();
    const e = await open(s.path);
    try {
      const [inCounter, inRoot] = await e.mutation(async (db) => [
        await db.inComponent(s.ids.counter, () => db.insert("notes", { where: "counter" })),
        await db.insert("notes", { where: "root" }),
      ]);
      expect([decodeId(inCounter).tableNumber, decodeId(inRoot).tableNumber]).toEqual([10003, 10002]);
      const seen = await e.query(async (db) => ({
        root: (await db.query("notes").collect()).map((d) => d.where),
        counter: (await db.inComponent(s.ids.counter, () => db.query("notes").collect())).map((d) => d.where),
      }));
      expect(seen).toEqual({ root: ["root"], counter: ["counter"] });
    } finally {
      await e.close();
    }
  });

  test("an index change on a component's table touches its `_tables` row (`catalogTouches`)", async () => {
    const s = await store();
    const e = await open(s.path);
    try {
      const counters = e.catalog.components.get(s.ids.counter)!.table("counters");
      // A real change to the index's row (a replace with the same row writes nothing), rolled back after the count.
      let touches = -1;
      const rollback = new Error("rollback");
      await expect(
        e.mutation((db) =>
          db.asSystem(async () => {
            const ix = counters.indexes.get("by_name")!;
            const row = (await db.get("_index", ix.metaId!))!;
            await db.replace("_index", ix.metaId!, { ...row, _id: undefined, _creationTime: undefined, touched: true });
            touches = db.catalogTouches().length;
            throw rollback;
          }),
        ),
      ).rejects.toBe(rollback);
      expect(touches).toBe(1);
    } finally {
      await e.close();
    }
  });

  test("the namespace is restored when `fn` returns or throws; an unknown component is refused", async () => {
    const s = await store();
    const e = await open(s.path);
    try {
      await e.query(async (db) => {
        expect(db.componentId).toBeNull();
        await db.inComponent(s.ids.counter, async () => {
          expect(db.componentId).toBe(s.ids.counter);
          await db.inComponent(s.ids.second, async () => expect(db.componentId).toBe(s.ids.second));
          expect(db.componentId).toBe(s.ids.counter);
          // `null` is the root, from inside a component.
          await db.inComponent(null, async () => expect((await db.query("messages").collect())[0]?.text).toBe("root"));
        });
        await expect(
          db.inComponent(s.ids.counter, async () => {
            throw new Error("boom");
          }),
        ).rejects.toThrow("boom");
        expect(db.componentId).toBeNull();
        expect((await db.query("messages").collect()).map((d) => d.text)).toEqual(["root"]);
        await expect(db.inComponent(s.ids.root, async () => null)).rejects.toThrow(
          `No namespace for component ${s.ids.root}`,
        );
      });
    } finally {
      await e.close();
    }
  });

  test("a component's write conflicts with a concurrent one on the same document: one read and write set", async () => {
    const s = await store();
    const e = await open(s.path);
    try {
      const id = await e.mutation((db) =>
        db.inComponent(s.ids.counter, () => db.insert("counters", { name: "c", value: 0 })),
      );
      const bump = () =>
        e.mutation((db) =>
          db.inComponent(s.ids.counter, async () => {
            const d = await db.get("counters", id);
            await db.patch("counters", id, { value: (d!.value as number) + 1 });
          }),
        );
      await Promise.all(Array.from({ length: 5 }, bump));
      expect(await e.query((db) => db.inComponent(s.ids.counter, () => db.get("counters", id)))).toMatchObject({
        value: 5,
      });
    } finally {
      await e.close();
    }
  });
});
