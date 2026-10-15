// A store with components, built with bunvex's own catalog API (STUDY-152 steps 1–2), as Convex lays one out
// (convex-rows/components.json): a root with `messages`, and a `counter` component mounted twice (`counter`,
// `second`), each in its own namespace with Convex's system tables, `counters` (10001) and `messages` (10002).
// The rows written are Convex's (`componentRow`); the store the Convex binary itself writes is checked in
// packages/differential (component-store.test.ts).
import { v } from "@bunvex/values";
import { databaseIndexRows, planCatalog, tableMeta } from "../src/catalog.ts";
import { writeCatalogChanges } from "../src/catalog-writes.ts";
import { componentRow } from "../src/components.ts";
import { Engine } from "../src/engine.ts";
import { readNextIndexId } from "../src/index-ids.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import { type DeclaredTable, defineSchema, defineTable } from "../src/schema.ts";

export const rootSchema = defineSchema({ messages: defineTable({ text: v.string() }).index("by_text", ["text"]) });

/** Each component's own tables, as the `counter` definition declares them. */
const COMPONENT_TABLES: DeclaredTable[] = [
  { name: "counters", indexes: { by_name: ["name"] }, document: v.any() },
  { name: "messages", indexes: { by_n: ["n"] }, document: v.any() },
];

export type ComponentStore = { path: string; ids: { root: string; counter: string; second: string } };

/** Build the store in `path` (a MemoryPersistence log): one root message, one document per component table. */
export async function buildComponentStore(path: string): Promise<ComponentStore> {
  const open = async () => new Engine(rootSchema, await MemoryPersistence.open(path, { durable: false })).init();
  let e = await open();
  const counter = await e.initializeComponentNamespace();
  const second = await e.initializeComponentNamespace();
  const root = await e.mutation((db) =>
    db.asSystem(async () => {
      for (const id of [counter, second]) {
        const tables = (await db.query("_tables").collect()).map(tableMeta);
        const indexes = databaseIndexRows((await db.query("_index").collect()) as Record<string, unknown>[]);
        const plan = planCatalog(COMPONENT_TABLES, tables, indexes, true, await readNextIndexId(db), id);
        // Empty tables: their indexes enabled at once, as a push's finish leaves them.
        for (const i of plan.insertIndexes) {
          i.state = "enabled";
          delete i.staged;
        }
        await writeCatalogChanges(db, plan, 0n);
      }
      const components = e.catalog.table("_components");
      const definition = "kw2dbrczh84dvpdwhx5ycmywb58gb6j4";
      const rootId = await db.insert(
        "_components",
        componentRow({ definitionId: definition, parent: null, name: null, state: "active", httpPrefix: null }),
      );
      for (const [id, name] of [
        [second, "second"],
        [counter, "counter"],
      ] as const)
        await db.importInsert(components, {
          _id: id,
          ...componentRow({
            definitionId: definition,
            parent: rootId,
            name,
            args: [],
            env: [],
            state: "active",
            httpPrefix: null,
          }),
        });
      await db.insert("messages", { text: "root" });
      return rootId;
    }),
  );
  await e.close();
  // Reopened: the catalog is built from the stored rows, as a start does. Each component's documents are written
  // in its namespace, where the root's schema (`messages` with `text`) does not apply.
  e = await open();
  await e.mutation(async (db) => {
    for (const [id, body] of [
      [counter, "in counter"],
      [second, "in second"],
    ] as const)
      await db.inComponent(id, async () => {
        await db.insert("messages", { body, n: 1 });
        await db.insert("counters", { name: body, value: 1 });
      });
  });
  await e.close();
  return { path, ids: { root, counter, second } };
}
