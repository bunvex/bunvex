// A push without a schema, as Convex's (STUDY-187 X3 follow-up): `start_component_schema_changes` submits nothing for a
// namespace without one (no table, no index, no `_schemas` row: its schema id is null), and `finish_push`'s
// `SchemaModel::apply(None)` marks the namespace's active schema `overwritten` with none in its place (`clear_active`)
// while `IndexModel::apply` drops every index the schema no longer declares — all of them (`get_index_diff`, which
// diffs every application index of the namespace, so a table a schema stops declaring loses its indexes too).
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { v } from "@bunvex/values";
import { SCHEMAS_TABLE } from "../src/catalog.ts";
import { Engine } from "../src/engine.ts";
import { SqlitePersistence } from "../src/persistence/sqlite.ts";
import { declaredTables, defineSchema, defineTable, type EngineSchema } from "../src/schema.ts";

const engines: Engine[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const e of engines.splice(0)) await e.close().catch(() => {});
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "bunvex-push-without-schema-"));
  dirs.push(d);
  return join(d, "db.sqlite");
};
const open = async (path = tmp()) => {
  const e = await new Engine(defineSchema({}), new SqlitePersistence(path, { durable: true }), {
    storedSchema: true,
    indexBackfill: { chunkRate: null },
  }).init();
  engines.push(e);
  return e;
};
const until = async (f: () => Promise<boolean>) => {
  for (let i = 0; i < 400; i++) {
    if (await f()) return;
    await Bun.sleep(5);
  }
  throw new Error("timed out");
};
const settled = (e: Engine, id: string, ns: string | null = null) =>
  until(async () => (await e.schemaPushStatus(id, ns)).type !== "inProgress");
const push = async (e: Engine, s: EngineSchema, components: Map<string, EngineSchema> = new Map()) => {
  const p = await e.startSchemaPush(s, components);
  await settled(e, p.schemaId);
  const ids = new Map<string, string>();
  for (const [id, c] of p.components) {
    await settled(e, c.schemaId!, id);
    ids.set(id, c.schemaId!);
  }
  return e.commitSchemaPush(p.schemaId, async () => {}, ids);
};
const states = async (e: Engine, ns: string | null = null) =>
  (
    (await e.query((db) => db.asSystem(() => db.inComponent(ns, () => db.query(SCHEMAS_TABLE).collect())))) as Record<
      string,
      unknown
    >[]
  ).map((r) => (r.state as { state: string }).state);
const items = defineSchema({ items: defineTable({ n: v.number() }).index("by_n", ["n"]) });

describe("a push without a schema", () => {
  test("no row at its start; its finish drops every index and overwrites the active schema, none in its place", async () => {
    const e = await open();
    await push(e, items);
    await e.mutation((db) => db.insert("items", { n: 1 }));
    const p = await e.startSchemaPush(null);
    expect(p.schemaId).toBeNull();
    expect(await states(e)).toEqual(["active"]);
    // Until the finish, the indexes serve the running code.
    expect(e.catalog.tables.get("items")!.indexes.has("by_n")).toBe(true);
    const done = await e.commitSchemaPush(null, async () => {});
    expect(done.indexDiff.dropped).toEqual(["items.by_n"]);
    expect(await states(e)).toEqual(["overwritten"]);
    expect(e.catalog.tables.get("items")!.indexes.has("by_n")).toBe(false);
    expect(declaredTables(e.schema).size).toBe(0);
    // The documents stay, and a write of any shape goes in: no schema checks it.
    await e.mutation((db) => db.insert("items", { n: "text" }));
    expect((await e.query((db) => db.query("items").collect())).length).toBe(2);
    // Again: nothing to overwrite, nothing written.
    await e.startSchemaPush(null);
    await e.commitSchemaPush(null, async () => {});
    expect(await states(e)).toEqual(["overwritten"]);
  });

  test("a restart starts on no schema, and a later push makes a new active schema", async () => {
    const path = tmp();
    const e = await open(path);
    await push(e, items);
    await e.startSchemaPush(null);
    await e.commitSchemaPush(null, async () => {});
    await e.close();
    engines.splice(engines.indexOf(e), 1);
    const again = await open(path);
    expect(declaredTables(again.schema).size).toBe(0);
    expect(again.catalog.tables.get("items")!.indexes.has("by_n")).toBe(false);
    await push(again, items);
    expect(await states(again)).toEqual(["overwritten", "active"]);
    expect(again.catalog.tables.get("items")!.indexes.has("by_n")).toBe(true);
  });

  test("a pending schema of an earlier push is left pending, as Convex's (only the active one is cleared)", async () => {
    const e = await open();
    await push(e, items);
    await e.mutation((db) => db.insert("items", { n: 1 }));
    // A schema the document does not match would fail; one it matches stays pending while its push is unfinished.
    const earlier = await e.startSchemaPush(
      defineSchema({ items: defineTable({ n: v.number() }), other: defineTable(v.any()) }),
    );
    await settled(e, earlier.schemaId);
    await e.startSchemaPush(null);
    await e.commitSchemaPush(null, async () => {});
    expect((await states(e)).sort()).toEqual(["overwritten", "validated"]);
  });

  test("a table the schema stops declaring loses its indexes at the finish, as Convex's `get_index_diff`", async () => {
    const e = await open();
    await push(e, items);
    const done = await push(e, defineSchema({ other: defineTable(v.any()).index("by_x", ["x"]) }));
    expect(done.indexDiff.dropped).toEqual(["items.by_n"]);
    expect(e.catalog.tables.get("items")!.indexes.has("by_n")).toBe(false);
    expect(e.catalog.tables.get("other")!.indexes.has("by_x")).toBe(true);
  });

  test("a component pushed without its schema: its namespace's active one overwritten and its indexes dropped", async () => {
    const e = await open();
    const ns = await e.initializeComponentNamespace();
    const kv = defineSchema({ entries: defineTable({ k: v.string() }).index("by_k", ["k"]) });
    await push(e, items, new Map([[ns, kv]]));
    expect(await states(e, ns)).toEqual(["active"]);
    // The app keeps its schema; the component has none.
    const p = await e.startSchemaPush(items, new Map([[ns, null]]));
    expect(p.components.get(ns)!.schemaId).toBeNull();
    await settled(e, p.schemaId);
    const done = await e.commitSchemaPush(p.schemaId, async () => {}, new Map(), new Set([ns]));
    expect(done.components.get(ns)!.dropped).toEqual(["entries.by_k"]);
    expect(await states(e, ns)).toEqual(["overwritten"]);
    expect(await states(e)).toEqual(["active"]);
    expect(declaredTables(e.componentSchema(ns)).size).toBe(0);
    expect(e.catalog.tables.get("items")!.indexes.has("by_n")).toBe(true);
  });
});
