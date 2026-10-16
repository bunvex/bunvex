// Writes in a component (STUDY-154 PR 1): its own active schema enforced with the root's message, a write into an
// unmounted component refused, and `.paginate()` refused in a component's function, as Convex's.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { v } from "@bunvex/values";
import { componentRow } from "../src/components.ts";
import { Engine } from "../src/engine.ts";
import { SqlitePersistence } from "../src/persistence/sqlite.ts";
import { defineSchema, defineTable } from "../src/schema.ts";

const engines: Engine[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const e of engines.splice(0)) await e.close().catch(() => {});
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const open = async () => {
  const d = mkdtempSync(join(tmpdir(), "bunvex-component-writes-"));
  dirs.push(d);
  const e = await new Engine(defineSchema({}), new SqlitePersistence(join(d, "db.sqlite"), { durable: true }), {
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

/** The root's schema and a component's, each with a `messages` of its own shape. */
const root = defineSchema({ messages: defineTable({ text: v.string() }) });
const counter = defineSchema({
  messages: defineTable({ body: v.string() }).index("by_body", ["body"]),
  notes: defineTable({ ref: v.optional(v.id("notes")) }),
});

/** A component `counter` with its schema active, its `_components` row in `state`. */
async function component(e: Engine, state: "active" | "unmounted" = "active") {
  const id = await e.initializeComponentNamespace();
  const p = await e.startSchemaPush(root, new Map([[id, counter]]));
  await until(async () => (await e.schemaPushStatus(p.schemaId)).type === "complete");
  await until(async () => (await e.schemaPushStatus(p.components.get(id)!.schemaId!, id)).type === "complete");
  await e.commitSchemaPush(p.schemaId, async () => {}, new Map([[id, p.components.get(id)!.schemaId!]]));
  await e.mutation((db) =>
    db.asSystem(async () => {
      const definitionId = await db.insert("_component_definitions", { path: "counter" } as never);
      const app = await db.insert(
        "_components",
        componentRow({ definitionId, parent: null, name: null, state: "active", httpPrefix: null }) as never,
      );
      await db.importInsert(e.catalog.table("_components")!, {
        _id: id,
        ...componentRow({ definitionId, parent: app, name: "counter", args: [], env: [], state, httpPrefix: null }),
      });
    }),
  );
  return id;
}
const failure = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("succeeded");
};

describe("a component's schema on writes", () => {
  test("its documents are checked against its own schema, with the root's message; the root's against the root's", async () => {
    const e = await open();
    const id = await component(e);
    await e.mutation((db) => db.inComponent(id, () => db.insert("messages", { body: "ok" })));
    expect(
      await failure(
        e.mutation((db) => db.inComponent(id, () => db.insert("messages", { text: "root's shape" } as never))),
      ),
    ).toStartWith('Failed to insert or update a document in table "messages" because it does not match the schema: ');
    // The root's `messages` keeps the root's shape.
    await e.mutation((db) => db.insert("messages", { text: "root" }));
    expect(await failure(e.mutation((db) => db.insert("messages", { body: "x" } as never)))).toStartWith(
      'Failed to insert or update a document in table "messages"',
    );
  });

  test("an id in its documents names its own tables (`notes`, which the app does not have)", async () => {
    const e = await open();
    const id = await component(e);
    await e.mutation((db) =>
      db.inComponent(id, async () => {
        const a = await db.insert("notes", {});
        await db.insert("notes", { ref: a });
      }),
    );
  });
});

describe("refused in a component", () => {
  test("a user's write into an unmounted component; the server's own writes there are not", async () => {
    const e = await open();
    const id = await component(e, "unmounted");
    const message =
      "Cannot perform write operations in an unmounted component. Make sure your component is installed in your `bunvex.config.ts` file.";
    expect(await failure(e.mutation((db) => db.inComponent(id, () => db.insert("messages", { body: "x" }))))).toBe(
      message,
    );
    // Reads are fine: its data is kept, read-only.
    expect(await e.query((db) => db.inComponent(id, () => db.query("messages").collect()))).toEqual([]);
    await e.mutation((db) => db.asSystem(() => db.inComponent(id, () => db.insert("messages", { body: "server" }))));
    const [doc] = await e.query((db) => db.inComponent(id, () => db.query("messages").collect()));
    for (const write of [
      (db: Parameters<Parameters<Engine["mutation"]>[0]>[0]) => db.patch(doc!._id, { body: "y" }),
      (db: Parameters<Parameters<Engine["mutation"]>[0]>[0]) => db.replace(doc!._id, { body: "y" }),
      (db: Parameters<Parameters<Engine["mutation"]>[0]>[0]) => db.delete(doc!._id),
    ])
      expect(await failure(e.mutation((db) => db.inComponent(id, () => write(db))))).toBe(message);
  });

  test(".paginate() in a component's function, after the page's own checks; the app's is fine", async () => {
    const e = await open();
    const id = await component(e);
    const page = (componentFunction: boolean, numItems = 10) =>
      e.query(async (db) => {
        db.componentFunction = componentFunction;
        return db.inComponent(id, () => db.query("messages").paginate({ numItems, cursor: null }));
      });
    expect(await failure(page(true))).toBe("paginate() is only supported in the app.");
    expect(await failure(page(true, 0))).toBe("Must request at least 1 document while paginating");
    // The engine's own reads in the namespace, and the app's function, page as before.
    expect((await page(false)).isDone).toBe(true);
    expect((await e.query((db) => db.query("messages").paginate({ numItems: 1, cursor: null }))).isDone).toBe(true);
  });
});
