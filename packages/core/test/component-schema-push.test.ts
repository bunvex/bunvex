// A push's schema change across namespaces (STUDY-153 PR 2b), as Convex's `start_component_schema_changes` and
// `finish_push`: each component's schema is submitted in its own namespace (its tables, indexes and `_schemas` row
// there) in the push's start commit, its existing documents walked as the root's, and every namespace's schema made
// active in the push's ONE finish commit.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeId, v } from "@bunvex/values";
import { SCHEMAS_TABLE } from "../src/catalog.ts";
import { Engine, SchemaPushError } from "../src/engine.ts";
import { SqlitePersistence } from "../src/persistence/sqlite.ts";
import { defineSchema, defineTable, type SchemaDefinition } from "../src/schema.ts";

const engines: Engine[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const e of engines.splice(0)) await e.close().catch(() => {});
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "bunvex-component-push-"));
  dirs.push(d);
  return join(d, "db.sqlite");
};
const open = async (path: string) => {
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

/** The root's schema: `messages` with `text`. */
const root = defineSchema({ messages: defineTable({ text: v.string() }) });
/** A component's: `counters`, and `messages` of another shape than the root's, each with an index. */
const counter1 = defineSchema({
  counters: defineTable({ name: v.string(), value: v.number() }).index("by_name", ["name"]),
  messages: defineTable({ body: v.string(), n: v.number() }).index("by_n", ["n"]),
});
/** Its next version: `messages.body` required to be a number. */
const counter2 = defineSchema({
  counters: defineTable({ name: v.string(), value: v.number() }).index("by_name", ["name"]),
  messages: defineTable({ body: v.number(), n: v.number() }).index("by_n", ["n"]),
});

const schemasIn = (e: Engine, id: string | null) =>
  e.query((db) => db.asSystem(() => db.inComponent(id, () => db.query(SCHEMAS_TABLE).collect())));
const complete = async (e: Engine, schemaId: string, ns: string | null = null) =>
  until(async () => (await e.schemaPushStatus(schemaId, ns)).type === "complete");

/** Push `rootSchema` and each component's schema, wait, and commit them all. */
async function push(e: Engine, rootSchema: SchemaDefinition, components: Map<string, SchemaDefinition>) {
  const p = await e.startSchemaPush(rootSchema, components);
  await complete(e, p.schemaId);
  const ids = new Map<string, string>();
  for (const [id, c] of p.components) {
    await complete(e, c.schemaId!, id);
    ids.set(id, c.schemaId!);
  }
  return { start: p, finish: await e.commitSchemaPush(p.schemaId, async () => {}, ids) };
}

describe("component schema pushes", () => {
  test("a fresh namespace: its tables, indexes and `_schemas` row in it, the root's untouched", async () => {
    const e = await open(tmp());
    const id = await e.initializeComponentNamespace();
    const { start, finish } = await push(e, root, new Map([[id, counter1]]));
    expect(start.addedIndexes).toEqual([]);
    expect(start.components.get(id)!.addedIndexes.sort()).toEqual(["counters.by_name", "messages.by_n"]);
    expect(finish.components.get(id)!.enabled.sort()).toEqual(["counters.by_name", "messages.by_n"]);
    // Numbered in the namespace from 10001; the root's `messages` is its own 10001.
    const ns = e.catalog.components.get(id)!;
    expect([ns.table("counters").number, ns.table("messages").number]).toEqual([10001, 10002]);
    expect(e.catalog.table("messages").number).toBe(10001);
    expect(e.catalog.tables.has("counters")).toBe(false);
    // One active schema per namespace, each its own row.
    const [rootRows, componentRows] = [await schemasIn(e, null), await schemasIn(e, id)];
    expect(rootRows).toHaveLength(1);
    expect(componentRows).toHaveLength(1);
    expect(componentRows[0]).toMatchObject({ state: { state: "active" } });
    expect(
      JSON.parse(componentRows[0]!.schema as string).tables.map((t: { tableName: string }) => t.tableName),
    ).toEqual(["counters", "messages"]);
    expect(e.componentSchema(id).tables).toHaveProperty("counters");
    // Its indexes serve, in its namespace.
    const docId = await e.mutation((db) => db.inComponent(id, () => db.insert("messages", { body: "b", n: 7 })));
    expect(decodeId(docId).tableNumber).toBe(10002);
    const found = await e.query((db) =>
      db.inComponent(id, () =>
        db
          .query("messages")
          .withIndex("by_n", (q) => q.eq("n", 7))
          .collect(),
      ),
    );
    expect(found.map((d) => d.body)).toEqual(["b"]);
  });

  test("a component's tables are numbered as Convex's push numbers them: the indexed ones first, by name", async () => {
    const e = await open(tmp());
    const id = await e.initializeComponentNamespace();
    // Declared out of order; `alpha` and `posts` have an index, `beta` and `zeta` none.
    const s = defineSchema({
      zeta: defineTable({ a: v.string() }),
      posts: defineTable({ a: v.string() }).index("by_a", ["a"]),
      beta: defineTable({ a: v.string() }),
      alpha: defineTable({ a: v.string() }).index("by_a", ["a"]),
    });
    await push(e, root, new Map([[id, s]]));
    const ns = e.catalog.components.get(id)!;
    expect(["alpha", "posts", "beta", "zeta"].map((t) => ns.table(t).number)).toEqual([10001, 10002, 10003, 10004]);
  });

  test("a component's documents are walked in its namespace: a failure names them; the commit applies nothing", async () => {
    const e = await open(tmp());
    const id = await e.initializeComponentNamespace();
    await push(e, root, new Map([[id, counter1]]));
    // The root's `messages` has no document: the walk counts the component's (one) to decide it must walk.
    const bad = await e.mutation((db) => db.inComponent(id, () => db.insert("messages", { body: "text", n: 1 })));
    // The next push adds a root index; the component's schema no longer accepts its document.
    const rootNext = defineSchema({ messages: defineTable({ text: v.string() }).index("by_text", ["text"]) });
    const p = await e.startSchemaPush(rootNext, new Map([[id, counter2]]));
    const componentSchemaId = p.components.get(id)!.schemaId!;
    await until(async () => (await e.schemaPushStatus(componentSchemaId, id)).type === "failed");
    expect(await e.schemaPushStatus(componentSchemaId, id)).toEqual({
      type: "failed",
      tableName: "messages",
      error: expect.stringContaining(`Document with ID "${bad}" in table "messages" does not match the schema`),
    });
    // The root's walk does not see the component's `messages`.
    await complete(e, p.schemaId);
    // One commit for every namespace: the component's failure refuses it, and the root's index stays unfinished.
    const refused = await e
      .commitSchemaPush(p.schemaId, async () => {}, new Map([[id, componentSchemaId]]))
      .catch((x) => x);
    expect(refused).toBeInstanceOf(SchemaPushError);
    expect(refused).toMatchObject({
      code: "SchemaNotReady",
      message: expect.stringContaining("Schema validation failed"),
    });
    expect(e.catalog.table("messages").indexes.has("by_text")).toBe(false);
    expect((await schemasIn(e, null)).filter((r) => (r.state as { state: string }).state === "active")).toHaveLength(1);
    // The component keeps its active schema (`body` a string).
    expect(JSON.stringify(e.componentSchema(id).tables.messages)).toContain('"string"');
  });

  test("its status counts the indexes its namespace backfills", async () => {
    const e = await new Engine(defineSchema({}), new SqlitePersistence(tmp(), { durable: true }), {
      storedSchema: true,
      indexBackfill: { chunkSize: 10, chunkRate: 20 },
    }).init();
    engines.push(e);
    const id = await e.initializeComponentNamespace();
    const items = defineSchema({ items: defineTable(v.any()) });
    const first = await e.startSchemaPush(root, new Map([[id, items]]));
    await complete(e, first.components.get(id)!.schemaId!, id);
    await complete(e, first.schemaId);
    await e.commitSchemaPush(first.schemaId, async () => {}, new Map([[id, first.components.get(id)!.schemaId!]]));
    await e.mutation((db) =>
      db.inComponent(id, async () => {
        for (let n = 0; n < 300; n++) await db.insert("items", { n });
      }),
    );
    const p = await e.startSchemaPush(
      root,
      new Map([[id, defineSchema({ items: defineTable(v.any()).index("by_n", ["n"]) })]]),
    );
    const schemaId = p.components.get(id)!.schemaId!;
    expect(await e.schemaPushStatus(schemaId, id)).toMatchObject({ type: "inProgress", indexesTotal: 1 });
    await complete(e, schemaId, id);
  });

  test("a component's push left unfinished resumes at a restart, and its active schema is loaded", async () => {
    const path = tmp();
    let e = await open(path);
    const id = await e.initializeComponentNamespace();
    await push(e, root, new Map([[id, counter1]]));
    await e.mutation((db) => db.inComponent(id, () => db.insert("messages", { body: "x", n: 1 })));
    const p = await e.startSchemaPush(root, new Map([[id, counter2]]));
    const componentSchemaId = p.components.get(id)!.schemaId!;
    await e.close();
    e = await open(path);
    // Loaded: the active schema (counter1), and the pending one, walked again (and failing on the document).
    expect(Object.keys(e.componentSchema(id).tables).sort()).toEqual(["counters", "messages"]);
    await until(async () => (await e.schemaPushStatus(componentSchemaId, id)).type === "failed");
    // A push of a schema the document matches commits, after the restart.
    const ok = await e.startSchemaPush(root, new Map([[id, counter1]]));
    expect(ok.components.get(id)!.schemaId).not.toBe(componentSchemaId);
    await complete(e, ok.components.get(id)!.schemaId!, id);
    await e.commitSchemaPush(ok.schemaId, async () => {}, new Map([[id, ok.components.get(id)!.schemaId!]]));
    // The failed schema stays failed (Convex's `submit_pending` overwrites pending and validated ones only).
    expect((await e.schemaPushStatus(componentSchemaId, id)).type).toBe("failed");
    expect(Object.keys(e.componentSchema(id).tables).sort()).toEqual(["counters", "messages"]);
  });

  test("the same schema again is the active one; a component without a schema gets none", async () => {
    const e = await open(tmp());
    const [a, b] = [await e.initializeComponentNamespace(), await e.initializeComponentNamespace()];
    const first = await push(e, root, new Map([[a, counter1]]));
    const again = await e.startSchemaPush(
      root,
      new Map<string, typeof counter1 | null>([
        [a, counter1],
        [b, null],
      ]),
    );
    expect(again.components.get(a)!.schemaId).toBe(first.start.components.get(a)!.schemaId);
    expect(again.components.get(a)!.addedIndexes).toEqual([]);
    expect(again.components.get(b)).toEqual({ schemaId: null, addedIndexes: [] });
    expect(await schemasIn(e, b)).toEqual([]);
    expect(e.componentSchema(b).tables).toEqual({});
  });

  test("refused: a component's staged validator, search or vector index, an unknown namespace, a stale schema id", async () => {
    const e = await open(tmp());
    const id = await e.initializeComponentNamespace();
    const staged = defineSchema({ t: defineTable(v.object({ a: v.string() })).staged(v.any()) });
    await expect(e.startSchemaPush(root, new Map([[id, staged]]))).rejects.toThrow(
      'Table "t": staged validators in a component\'s schema are not supported yet',
    );
    const search = defineSchema({ t: defineTable({ a: v.string() }).searchIndex("s", { searchField: "a" }) });
    await expect(e.startSchemaPush(root, new Map([[id, search]]))).rejects.toThrow(
      'Table "t": search and vector indexes in a component\'s schema are not supported yet',
    );
    const missing = "kh7aaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    await expect(e.startSchemaPush(root, new Map([[missing, counter1]]))).rejects.toThrow(
      `No namespace for component ${missing}`,
    );
    // Nothing was written by the refused pushes.
    expect(await schemasIn(e, id)).toEqual([]);
    const p = await e.startSchemaPush(root, new Map([[id, counter1]]));
    await expect(e.commitSchemaPush(p.schemaId, async () => {}, new Map([[id, p.schemaId]]))).rejects.toThrow(
      new SchemaPushError("RaceDetected", "Schema was overwritten by another push."),
    );
  });
});
