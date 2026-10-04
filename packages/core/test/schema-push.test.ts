// A push's schema change (STUDY-35), as Convex's start_push → wait_for_schema → finish_push: new indexes
// backfill while the old ones keep serving; one commit enables, drops and switches the validators; a newer
// push overwrites an older one; a deployable engine restarts on the schema it was pushed.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { v } from "@bunvex/values";
import { SCHEMAS_TABLE } from "../src/catalog.ts";
import { Engine, SchemaPushError } from "../src/engine.ts";
import { SqlitePersistence } from "../src/persistence/sqlite.ts";
import { defineSchema, defineTable } from "../src/schema.ts";
import { schemaFromJson, schemaToJson } from "../src/schema-json.ts";

const engines: Engine[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const e of engines.splice(0)) await e.close().catch(() => {});
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "bunvex-push-"));
  dirs.push(d);
  return join(d, "db.sqlite");
};
const open = async (path: string, schema = defineSchema({}), storedSchema = true) => {
  const e = await new Engine(schema, new SqlitePersistence(path, { durable: true }), {
    storedSchema,
    indexBackfill: { chunkRate: null },
  }).init();
  engines.push(e);
  return e;
};
const v1 = defineSchema({ items: defineTable({ n: v.number(), tag: v.optional(v.string()) }).index("by_n", ["n"]) });
const v2 = defineSchema({ items: defineTable({ n: v.number(), tag: v.string() }).index("by_tag", ["tag"]) });
const until = async (f: () => Promise<boolean>) => {
  for (let i = 0; i < 400; i++) {
    if (await f()) return;
    await Bun.sleep(5);
  }
  throw new Error("timed out");
};
const byIndex = (e: Engine, index: string, field: string, value: string | number) =>
  e.query((db) =>
    db
      .query("items")
      .withIndex(index, (q) => q.eq(field, value))
      .collect(),
  );

describe("a push's schema change", () => {
  test("start → backfill → commit: old indexes serve until the commit, which switches everything at once", async () => {
    const e = await open(tmp());
    const p1 = await e.startSchemaPush(v1);
    expect(p1.addedIndexes).toEqual(["items.by_n"]);
    await until(async () => (await e.schemaPushStatus(p1.schemaId)).type === "complete");
    await e.commitSchemaPush(p1.schemaId, async () => {});
    for (let i = 0; i < 50; i++) await e.mutation((db) => db.insert("items", { n: i, tag: `t${i % 3}` }));
    // The next push: a new index backfills while by_n keeps serving and the old validators hold.
    const p2 = await e.startSchemaPush(v2);
    expect(p2.addedIndexes).toEqual(["items.by_tag"]);
    expect((await byIndex(e, "by_n", "n", 3)).length).toBe(1);
    const untagged = await e.mutation((db) => db.insert("items", { n: 99 })); // fine under v1 (tag optional)
    // ...but not under v2: the push fails, as Convex's, naming the document; the old schema keeps serving.
    await until(async () => (await e.schemaPushStatus(p2.schemaId)).type === "failed");
    const failed = await e.schemaPushStatus(p2.schemaId);
    expect(failed).toMatchObject({ type: "failed", tableName: "items" });
    expect((failed as { error: string }).error).toMatch(
      new RegExp(
        `^(Document with ID "${untagged}" in table "items" does not match the schema|Failed to insert or update a document in table "items" because it does not match the schema)`,
      ),
    );
    await expect(e.commitSchemaPush(p2.schemaId, async () => {})).rejects.toThrow(/Schema validation failed/);
    await e.mutation((db) => db.delete(untagged as string));
    const p2b = await e.startSchemaPush(v2);
    await until(async () => (await e.schemaPushStatus(p2b.schemaId)).type === "complete");
    expect((await byIndex(e, "by_n", "n", 3)).length).toBe(1); // still served: the push has not finished
    // The commit switches the validators for new writes (existing documents are validated separately).
    const r = await e.commitSchemaPush(p2b.schemaId, async () => "body ran");
    expect(r.value).toBe("body ran");
    expect(r.indexDiff).toEqual({ enabled: ["items.by_tag"], disabled: [], dropped: ["items.by_n"] });
    expect(p2b.addedIndexes).toEqual([]); // by_tag was added (and backfilled) by the failed push already
    expect((await byIndex(e, "by_tag", "tag", "t1")).length).toBe(17);
    await expect(byIndex(e, "by_n", "n", 3)).rejects.toThrow();
    await expect(e.mutation((db) => db.insert("items", { n: 1 }))).rejects.toThrow(/tag/);
    expect(e.schema.tables.get("items")!.indexes).toEqual({ by_tag: ["tag"] });
  });

  test("the status while indexes backfill: inProgress with counts", async () => {
    const e = await new Engine(defineSchema({}), new SqlitePersistence(tmp(), { durable: true }), {
      storedSchema: true,
      indexBackfill: { chunkSize: 10, chunkRate: 20 },
    }).init();
    engines.push(e);
    const p0 = await e.startSchemaPush(defineSchema({ items: defineTable(v.any()) }));
    await until(async () => (await e.schemaPushStatus(p0.schemaId)).type === "complete");
    await e.commitSchemaPush(p0.schemaId, async () => {});
    for (let i = 0; i < 300; i += 100)
      await e.mutation(async (db) => {
        for (let j = i; j < i + 100; j++) await db.insert("items", { n: j });
      });
    const p = await e.startSchemaPush(defineSchema({ items: defineTable(v.any()).index("by_n", ["n"]) }));
    expect(await e.schemaPushStatus(p.schemaId)).toMatchObject({
      type: "inProgress",
      indexesComplete: 0,
      indexesTotal: 1,
    });
    await expect(e.commitSchemaPush(p.schemaId, async () => {})).rejects.toBeInstanceOf(SchemaPushError);
    await until(async () => (await e.schemaPushStatus(p.schemaId)).type === "complete");
    await e.commitSchemaPush(p.schemaId, async () => {});
  });

  test("the status counts every index there is, as Convex: a changed index waits for its new version; staged ones do not count", async () => {
    const e = await new Engine(defineSchema({}), new SqlitePersistence(tmp(), { durable: true }), {
      storedSchema: true,
      indexBackfill: { chunkSize: 10, chunkRate: 20 },
    }).init();
    engines.push(e);
    const p0 = await e.startSchemaPush(defineSchema({ items: defineTable(v.any()).index("by_a", ["a"]) }));
    await until(async () => (await e.schemaPushStatus(p0.schemaId)).type === "complete");
    await e.commitSchemaPush(p0.schemaId, async () => {});
    await e.mutation(async (db) => {
      for (let j = 0; j < 300; j++) await db.insert("items", { a: j, b: j });
    });
    // by_a gets another field (its new version backfills next to the enabled one); by_s is staged.
    const p = await e.startSchemaPush(
      defineSchema({
        items: defineTable(v.any())
          .index("by_a", ["a", "b"])
          .index("by_s", { fields: ["b"], staged: true }),
      }),
    );
    // Convex's test_component_status_skips_staged_index: the staged index is not counted.
    expect(await e.schemaPushStatus(p.schemaId)).toMatchObject({
      type: "inProgress",
      indexesComplete: 1,
      indexesTotal: 2,
    });
    // Still in progress once the documents are validated: the new by_a is not ready (it used to say complete
    // here, and then `finish_push` refused: "The schema's indexes are still backfilling").
    await until(async () => {
      const s = await e.schemaPushStatus(p.schemaId);
      return s.type === "inProgress" && s.schemaValidationComplete;
    });
    await until(async () => (await e.schemaPushStatus(p.schemaId)).type === "complete");
    await e.commitSchemaPush(p.schemaId, async () => {});
    expect((await byIndex(e, "by_a", "a", 7)).length).toBe(1);
  });

  test("a newer push overwrites an older one: raceDetected, and its commit is refused", async () => {
    const e = await open(tmp());
    const a = await e.startSchemaPush(v1);
    const b = await e.startSchemaPush(v2);
    expect(await e.schemaPushStatus(a.schemaId)).toEqual({ type: "raceDetected" });
    const err = await e.commitSchemaPush(a.schemaId, async () => {}).catch((x) => x);
    expect(err).toBeInstanceOf(SchemaPushError);
    expect((err as SchemaPushError).code).toBe("RaceDetected");
    await until(async () => (await e.schemaPushStatus(b.schemaId)).type === "complete");
    await e.commitSchemaPush(b.schemaId, async () => {});
    expect((await e.schemaPushStatus(b.schemaId)).type).toBe("complete");
  });

  test("a commit whose body throws changes nothing; the push can commit again", async () => {
    const e = await open(tmp());
    const p = await e.startSchemaPush(v1);
    await until(async () => (await e.schemaPushStatus(p.schemaId)).type === "complete");
    await expect(
      e.commitSchemaPush(p.schemaId, async () => {
        throw new Error("code rows failed");
      }),
    ).rejects.toThrow("code rows failed");
    // Still the old schema: no validators (v1 wants a number), and the push not active.
    expect(
      await e.query((db) => db.asSystem(async () => (await db.query(SCHEMAS_TABLE).collect()).map((r) => r.state))),
    ).toEqual(["validated"]);
    await e.commitSchemaPush(p.schemaId, async () => {});
    await expect(e.mutation((db) => db.insert("items", { n: "now validated" }))).rejects.toThrow();
    expect((await e.query((db) => db.query("items").collect())).length).toBe(0);
  });

  test("an index the new schema drops is not dropped by the backfill's end, only by the commit", async () => {
    const e = await open(tmp());
    const p1 = await e.startSchemaPush(v1);
    await until(async () => (await e.schemaPushStatus(p1.schemaId)).type === "complete");
    await e.commitSchemaPush(p1.schemaId, async () => {});
    await e.mutation((db) => db.insert("items", { n: 1, tag: "a" }));
    const p2 = await e.startSchemaPush(v2);
    await until(async () => (await e.schemaPushStatus(p2.schemaId)).type === "complete");
    await Bun.sleep(50); // the worker is done: it must not have finished the schema change on its own
    expect((await byIndex(e, "by_n", "n", 1)).length).toBe(1);
    await expect(byIndex(e, "by_tag", "tag", "a")).rejects.toThrow();
  });

  test("two pushes in a row, each backfilling an index: the worker runs again for the second", async () => {
    const e = await open(tmp());
    const base = await e.startSchemaPush(defineSchema({ items: defineTable(v.any()) }));
    await until(async () => (await e.schemaPushStatus(base.schemaId)).type === "complete");
    await e.commitSchemaPush(base.schemaId, async () => {});
    await e.mutation(async (db) => {
      for (let i = 0; i < 50; i++) await db.insert("items", { n: i, m: i % 5 });
    });
    for (const [name, field] of [
      ["by_n", "n"],
      ["by_m", "m"],
    ] as const) {
      const indexes: Record<string, string[]> = { by_n: ["n"] };
      if (name === "by_m") indexes.by_m = ["m"];
      const t = defineTable(v.any());
      for (const [k, f] of Object.entries(indexes)) t.index(k, f);
      const p = await e.startSchemaPush(defineSchema({ items: t }));
      await until(async () => (await e.schemaPushStatus(p.schemaId)).type === "complete");
      await e.commitSchemaPush(p.schemaId, async () => {});
      expect((await byIndex(e, name, field, 2)).length).toBe(name === "by_n" ? 1 : 10);
    }
  });

  test("a push started while the engine's own start is still backfilling keeps its indexes", async () => {
    // A store whose engine starts backfilling (its constructor schema adds an index to a full table)...
    const path = tmp();
    const a = await open(path, defineSchema({ items: defineTable(v.any()) }), false);
    await a.mutation(async (db) => {
      for (let i = 0; i < 300; i++) await db.insert("items", { n: i });
    });
    await a.close();
    engines.splice(engines.indexOf(a), 1);
    const b = await new Engine(
      defineSchema({ items: defineTable(v.any()).index("by_n", ["n"]) }),
      new SqlitePersistence(path, { durable: true }),
      { indexBackfill: { chunkSize: 20, chunkRate: 20 } },
    ).init();
    engines.push(b);
    // ...and a push meanwhile that wants another index: the start's backfill ending must not finish with
    // the old schema (which would drop the push's index).
    const p = await b.startSchemaPush(
      defineSchema({ items: defineTable(v.any()).index("by_n", ["n"]).index("by_n2", ["n"]) }),
    );
    await until(async () => (await b.schemaPushStatus(p.schemaId)).type === "complete");
    await Bun.sleep(100);
    await b.commitSchemaPush(p.schemaId, async () => {});
    expect((await byIndex(b, "by_n2", "n", 7)).length).toBe(1);
  });

  test("a deployable engine restarts on the schema it was pushed; the stored rows are Convex's states", async () => {
    const path = tmp();
    const a = await open(path);
    const p = await a.startSchemaPush(v1);
    await until(async () => (await a.schemaPushStatus(p.schemaId)).type === "complete");
    await a.commitSchemaPush(p.schemaId, async () => {});
    await a.mutation((db) => db.insert("items", { n: 7 }));
    const rows = await a.query((db) => db.asSystem(() => db.query(SCHEMAS_TABLE).collect()));
    expect(rows.map((r) => r.state)).toEqual(["active"]);
    await a.close();
    engines.splice(engines.indexOf(a), 1);
    const b = await open(path); // constructed with an empty schema
    expect((await byIndex(b, "by_n", "n", 7)).length).toBe(1);
    expect([...b.schema.tables.keys()]).toEqual(["items"]);
    await expect(b.mutation((db) => db.insert("items", { n: "not a number" }))).rejects.toThrow();
  });

  test("existing documents are checked: the first that does not match fails the push, named as Convex's", async () => {
    const e = await open(tmp());
    const p0 = await e.startSchemaPush(defineSchema({ items: defineTable(v.any()) }));
    await until(async () => (await e.schemaPushStatus(p0.schemaId)).type === "complete");
    await e.commitSchemaPush(p0.schemaId, async () => {});
    for (let i = 0; i < 600; i++) await e.mutation((db) => db.insert("items", { n: i }));
    const bad = await e.mutation((db) => db.insert("items", { n: "seven" }));
    const p = await e.startSchemaPush(defineSchema({ items: defineTable({ n: v.number() }) }));
    await until(async () => (await e.schemaPushStatus(p.schemaId)).type === "failed");
    expect(await e.schemaPushStatus(p.schemaId)).toEqual({
      type: "failed",
      tableName: "items",
      error: `Document with ID "${bad}" in table "items" does not match the schema: Value does not match validator.\nPath: .n\nValue: "seven"\nValidator: v.float64()`,
    });
  });

  test("a write while the schema is pending is accepted, and fails the pending schema if it does not match", async () => {
    const e = await open(tmp());
    const p0 = await e.startSchemaPush(defineSchema({ items: defineTable(v.any()) }));
    await until(async () => (await e.schemaPushStatus(p0.schemaId)).type === "complete");
    await e.commitSchemaPush(p0.schemaId, async () => {});
    const p = await e.startSchemaPush(defineSchema({ items: defineTable({ n: v.number() }) }));
    await until(async () => (await e.schemaPushStatus(p.schemaId)).type === "complete");
    // Validated, not yet committed: a write the new schema refuses still lands (the active schema allows it)…
    await e.mutation((db) => db.insert("items", { n: "late" }));
    expect((await e.query((db) => db.query("items").collect())).length).toBe(1);
    // …and fails the pending schema.
    await until(async () => (await e.schemaPushStatus(p.schemaId)).type === "failed");
    expect(((await e.schemaPushStatus(p.schemaId)) as { error: string }).error).toMatch(
      /^Failed to insert or update a document in table "items" because it does not match the schema: /,
    );
    await expect(e.commitSchemaPush(p.schemaId, async () => {})).rejects.toThrow(/Schema validation failed/);
  });

  test("a table whose validator did not change is not walked, unless validation was off", async () => {
    const e = await open(tmp());
    const loose = defineSchema({ items: defineTable({ n: v.number() }) }, { schemaValidation: false });
    const p0 = await e.startSchemaPush(loose);
    await until(async () => (await e.schemaPushStatus(p0.schemaId)).type === "complete");
    await e.commitSchemaPush(p0.schemaId, async () => {});
    await e.mutation((db) => db.insert("items", { n: "not checked while validation is off" }));
    const p = await e.startSchemaPush(defineSchema({ items: defineTable({ n: v.number() }) }));
    await until(async () => (await e.schemaPushStatus(p.schemaId)).type !== "inProgress");
    expect((await e.schemaPushStatus(p.schemaId)).type).toBe("failed");
  });

  test("schemaToJson / schemaFromJson round-trip (Convex's DatabaseSchema shape)", () => {
    const s = defineSchema(
      {
        items: defineTable({ n: v.number(), tags: v.array(v.string()), kind: v.union(v.literal("a"), v.literal(2n)) })
          .index("by_n", ["n"])
          .index("staged_one", { fields: ["kind"], staged: true }),
        loose: defineTable(v.any()),
      },
      { schemaValidation: false },
    );
    const j = schemaToJson(s);
    expect(j.tables[0]).toMatchObject({
      tableName: "items",
      indexes: [{ indexDescriptor: "by_n", fields: ["n"] }],
      stagedDbIndexes: [{ indexDescriptor: "staged_one", fields: ["kind"] }],
    });
    expect(j.tables[1]!.documentType).toBeNull();
    expect(schemaToJson(schemaFromJson(JSON.parse(JSON.stringify(j))))).toEqual(j);
  });
});
