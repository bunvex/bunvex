// STUDY-187 X10: a mutation that straddles a schema push. Its writes are checked against the schemas there were
// when it began; a push that makes a schema pending, validated or active before it commits must conflict with it
// (Convex: every schema lookup of a write, `SchemaRegistry::get_by_state`, reads `_schemas.by_state` at that
// state), so it runs again and its writes are checked against the new schema.
import { afterEach, describe, expect, test } from "bun:test";
import { v } from "@bunvex/values";
import { Engine } from "../src/engine.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import { defineSchema, defineTable } from "../src/schema.ts";

const engines: Engine[] = [];
afterEach(async () => {
  for (const e of engines.splice(0)) await e.close().catch(() => {});
});
const open = async () => {
  const e = await new Engine(defineSchema({}), await MemoryPersistence.open(null, { durable: false }), {
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
const loose = defineSchema({ items: defineTable(v.any()) });
const strict = defineSchema({ items: defineTable({ n: v.number() }) });

/** A schema pushed to the end (pending, validated, active). */
const pushAll = async (e: Engine, schema: NonNullable<Parameters<Engine["startSchemaPush"]>[0]>) => {
  const p = await e.startSchemaPush(schema);
  await until(async () => (await e.schemaPushStatus(p.schemaId)).type !== "inProgress");
  expect((await e.schemaPushStatus(p.schemaId)).type).toBe("complete");
  await e.commitSchemaPush(p.schemaId, async () => {});
  return p.schemaId;
};

/** A gate a mutation waits on, so a push can run between its write and its commit. */
const gate = () => {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
};

/** Every document of `items` whose `n` is not a number. */
const violating = async (e: Engine) =>
  (await e.query((db) => db.query("items").collect())).filter((d) => typeof d.n !== "number");

describe("a mutation that straddles a schema push (STUDY-187 X10)", () => {
  for (const docs of [0, 3]) {
    test(`a write made before the push, committed once the schema is active, is checked against it (${docs} documents)`, async () => {
      const e = await open();
      await pushAll(e, loose);
      for (let i = 0; i < docs; i++) await e.mutation((db) => db.insert("items", { n: i }));
      const g = gate();
      const wrote = gate();
      let runs = 0;
      const m = e.mutation(async (db) => {
        runs++;
        await db.insert("items", { n: "bad" });
        wrote.open();
        await g.p;
      });
      await wrote.p;
      // The push runs to the end while the mutation holds its write: pending, the walk (which cannot see it),
      // validated, active.
      await pushAll(e, strict);
      g.open();
      // The mutation conflicts, runs again under the active schema, and is refused by it.
      await expect(m).rejects.toThrow(
        /Failed to insert or update a document in table "items" because it does not match the schema/,
      );
      expect(runs).toBe(2);
      expect(await violating(e)).toEqual([]);
    });
  }

  test("a write made before the push, committed once the schema is validated, fails the schema", async () => {
    const e = await open();
    await pushAll(e, loose);
    const g = gate();
    const wrote = gate();
    let runs = 0;
    const m = e.mutation(async (db) => {
      runs++;
      await db.insert("items", { n: "bad" });
      wrote.open();
      await g.p;
    });
    await wrote.p;
    const p = await e.startSchemaPush(strict);
    await until(async () => (await e.schemaPushStatus(p.schemaId)).type !== "inProgress");
    expect((await e.schemaPushStatus(p.schemaId)).type).toBe("complete");
    g.open();
    // It runs again: the validated schema does not refuse the write, it fails (Convex's `enforce`).
    await m;
    expect(runs).toBe(2);
    // Failed by the mutation's own commit (Convex's `mark_failed` in `enforce`).
    expect((await e.schemaPushStatus(p.schemaId)).type).toBe("failed");
    await expect(e.commitSchemaPush(p.schemaId, async () => {})).rejects.toThrow(/Schema validation failed/);
  });

  test("a write made before the push, committed once it is pending, fails it (an empty table is not walked)", async () => {
    const e = await open();
    await pushAll(e, loose);
    const g = gate();
    const wrote = gate();
    let runs = 0;
    const m = e.mutation(async (db) => {
      runs++;
      await db.insert("items", { n: "bad" });
      wrote.open();
      await g.p;
    });
    await wrote.p;
    const p = await e.startSchemaPush(strict);
    g.open();
    await m;
    expect(runs).toBe(2);
    expect((await e.schemaPushStatus(p.schemaId)).type).toBe("failed");
  });

  test("a mutation begun as the push's commit turns visible is checked against the pending schema", async () => {
    const e = await open();
    await pushAll(e, loose);
    for (let i = 0; i < 3; i++) await e.mutation((db) => db.insert("items", { n: i }));
    const g = gate();
    const wrote = gate();
    let m: Promise<unknown> = Promise.resolve();
    const hooks = e as unknown as {
      backfillNewTables: (...a: unknown[]) => Promise<boolean>;
      runMutation: (body: unknown, system: boolean, source?: string, ...rest: unknown[]) => Promise<unknown>;
    };
    // Right after the push's commit (before its own code goes on), a mutation begins and writes.
    const backfill = hooks.backfillNewTables.bind(e);
    hooks.backfillNewTables = async (...a) => {
      m = e.mutation(async (db) => {
        await db.insert("items", { n: "bad" });
        wrote.open();
        await g.p;
      });
      await wrote.p;
      return backfill(...a);
    };
    // It commits once the walk has read every page, just before the walk marks the schema validated.
    const run = hooks.runMutation.bind(e);
    hooks.runMutation = async (body, system, source, ...rest) => {
      if (source === "_system/schema_worker") {
        g.open();
        await m;
      }
      return run(body, system, source, ...rest);
    };
    const p = await e.startSchemaPush(strict);
    await until(async () => (await e.schemaPushStatus(p.schemaId)).type !== "inProgress");
    expect((await e.schemaPushStatus(p.schemaId)).type).toBe("failed");
  });

  test("a write the validated schema refuses, committed while the push commits, keeps it from becoming active", async () => {
    const e = await open();
    await pushAll(e, loose);
    const p = await e.startSchemaPush(strict);
    await until(async () => (await e.schemaPushStatus(p.schemaId)).type !== "inProgress");
    const g = gate();
    const inBody = gate();
    const commit = e.commitSchemaPush(p.schemaId, async () => {
      inBody.open();
      await g.p;
    });
    await inBody.p;
    // However late any work of the engine's own runs after the mutation's commit (a schema failed by a later
    // transaction, `failSchemaPush`, would come after the push's commit here), the push must see the schema failed.
    const hooks = e as unknown as { failSchemaPush: (...a: unknown[]) => Promise<void> };
    const fail = hooks.failSchemaPush.bind(e);
    hooks.failSchemaPush = async (...a) => {
      await commit.catch(() => {});
      return fail(...a);
    };
    await e.mutation((db) => db.insert("items", { n: "bad" }));
    g.open();
    await expect(commit).rejects.toThrow(/Schema validation failed/);
    expect((await e.schemaPushStatus(p.schemaId)).type).toBe("failed");
  });

  test("a mutation that writes nothing a schema checks does not conflict with a push", async () => {
    const e = await open();
    await pushAll(e, loose);
    const g = gate();
    const read = gate();
    let runs = 0;
    const m = e.mutation(async (db) => {
      runs++;
      await db.query("items").collect();
      read.open();
      await g.p;
    });
    await read.p;
    await pushAll(e, strict);
    g.open();
    await m;
    expect(runs).toBe(1);
  });
});
