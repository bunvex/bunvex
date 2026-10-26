// What becomes of a schema a push replaces (STUDY-187 X3), as Convex's `SchemaModel`
// (crates/database/src/bootstrap_model/schema/mod.rs): activating a schema marks the previous active one
// `overwritten` (`clear_active`), and each time a schema is marked `overwritten` or `failed`, the `failed` and
// `overwritten` schemas of that namespace created at least an hour before the transaction's begin timestamp are
// deleted (`delete_old_failed_and_overwritten_schemas`). The three tests that port Convex's
// (`bootstrap_model/schema/tests.rs` at bea52bde0) say which one each is.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { v } from "@bunvex/values";
import { SCHEMAS_TABLE } from "../src/catalog.ts";
import { Engine } from "../src/engine.ts";
import { SqlitePersistence } from "../src/persistence/sqlite.ts";
import { defineSchema, defineTable, type EngineSchema } from "../src/schema.ts";
import { TestRuntime } from "../src/test-runtime.ts";

const HOUR = 60 * 60 * 1000;

const engines: Engine[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const e of engines.splice(0)) await e.close().catch(() => {});
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const open = async () => {
  const d = mkdtempSync(join(tmpdir(), "bunvex-schemas-overwritten-"));
  dirs.push(d);
  const rt = new TestRuntime({ now: Date.now() });
  const e = await new Engine(defineSchema({}), new SqlitePersistence(join(d, "db.sqlite"), { durable: true }), {
    storedSchema: true,
    indexBackfill: { chunkRate: null },
    runtime: rt,
  }).init();
  engines.push(e);
  return { e, rt };
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
  await e.commitSchemaPush(p.schemaId, async () => {}, ids);
  return { root: p.schemaId, components: ids };
};
const states = async (e: Engine, ns: string | null = null) => {
  const rows = (await e.query((db) =>
    db.asSystem(() => db.inComponent(ns, () => db.query(SCHEMAS_TABLE).collect())),
  )) as Record<string, unknown>[];
  return new Map(rows.map((r) => [r._id as string, (r.state as { state: string }).state]));
};
/**
 * Move the virtual clock by `ms`, then commit once, so the next transaction's snapshot (its begin timestamp) is
 * that late, as it is on a deployment that keeps running.
 */
const later = async (e: Engine, rt: TestRuntime, ms: number) => {
  await rt.advance(ms);
  await e.mutation((db) => db.insert("clock", {}));
};

const a = defineSchema({ first_table: defineTable(v.any()), clock: defineTable(v.any()) });
const b = defineSchema({ second_table: defineTable(v.any()), clock: defineTable(v.any()) });
const c = defineSchema({ third_table: defineTable(v.any()), clock: defineTable(v.any()) });

describe("the schema a push replaces", () => {
  // Convex's `overwrite_schema_by_state_with_active_schema_sets_active_to_overwritten`.
  test("activating a schema marks the previous active one overwritten, not deleted", async () => {
    const { e } = await open();
    const first = await push(e, a);
    const second = await push(e, b);
    const s = await states(e);
    expect(s.get(first.root)).toBe("overwritten");
    expect(s.get(second.root)).toBe("active");
    expect(s.size).toBe(2);
    // Pushing the active schema again changes nothing.
    await push(e, b);
    expect(await states(e)).toEqual(s);
  });

  // Convex's `overwrite_schema_deletes_old_overwritten_schemas`.
  test("a schema overwritten more than an hour after it was created is deleted at once", async () => {
    const { e, rt } = await open();
    await push(e, a);
    const pending = await e.startSchemaPush(b);
    await settled(e, pending.schemaId);
    await later(e, rt, 2 * HOUR);
    // Its replacement overwrites it, and it is old enough to go in the same commit.
    const next = await e.startSchemaPush(c);
    const s = await states(e);
    expect(s.has(pending.schemaId)).toBe(false);
    expect(s.get(next.schemaId)).toBe("pending");
  });

  test("an overwritten schema younger than an hour is kept until the next overwrite past its hour", async () => {
    const { e, rt } = await open();
    const first = await push(e, a);
    await later(e, rt, 30 * 60 * 1000);
    await push(e, b); // `first` overwritten, created 30 min ago: kept
    expect((await states(e)).get(first.root)).toBe("overwritten");
    await later(e, rt, 29 * 60 * 1000);
    const third = await push(e, c); // the second is overwritten; `first` is 59 min old: still kept
    let s = await states(e);
    expect(s.get(first.root)).toBe("overwritten");
    expect(s.get(third.root)).toBe("active");
    expect(s.size).toBe(3);
    // Nothing goes when no schema is marked: the hour passing is not enough.
    await later(e, rt, 2 * HOUR);
    expect((await states(e)).size).toBe(3);
    // The next mark deletes every overwritten schema more than an hour old: the two kept so far, and `third`,
    // overwritten now but created more than an hour ago.
    const fourth = await push(e, a);
    s = await states(e);
    expect([...s]).toEqual([[fourth.root, "active"]]);
  });

  // Convex's `failed_schema_deletes_old_failed_schema`.
  test("marking a schema failed deletes the failed schemas older than an hour, itself included", async () => {
    const { e, rt } = await open();
    await push(e, defineSchema({ items: defineTable(v.any()), clock: defineTable(v.any()) }));
    await e.mutation((db) => db.insert("items", { n: "text" }));
    // A schema the existing document does not match: its walk fails it.
    const failed = await e.startSchemaPush(
      defineSchema({ items: defineTable({ n: v.number() }), clock: defineTable(v.any()) }),
    );
    await settled(e, failed.schemaId);
    expect((await states(e)).get(failed.schemaId)).toBe("failed");
    // One the document matches, validated and not yet active.
    const second = await e.startSchemaPush(
      defineSchema({ items: defineTable({ n: v.string() }), clock: defineTable(v.any()) }),
    );
    await settled(e, second.schemaId);
    expect((await states(e)).get(second.schemaId)).toBe("validated");
    await later(e, rt, 2 * HOUR);
    // A write it does not match fails it, and both failed schemas are more than an hour old.
    await e.mutation((db) => db.insert("items", { n: 1 }));
    await until(async () => !(await states(e)).has(second.schemaId));
    const s = await states(e);
    expect(s.has(failed.schemaId)).toBe(false);
    expect([...s.values()]).toEqual(["active"]);
  });

  test("only the namespace whose schema is marked: a component's old rows stay when the root's go", async () => {
    const { e, rt } = await open();
    const ns = await e.initializeComponentNamespace();
    const comp1 = defineSchema({ counters: defineTable(v.any()) });
    const comp2 = defineSchema({ counters: defineTable({ n: v.optional(v.number()) }) });
    const first = await push(e, a, new Map([[ns, comp1]]));
    // The component's schema changes, the root's stays: each namespace has one overwritten row.
    const second = await push(e, b, new Map([[ns, comp2]]));
    expect((await states(e, ns)).get(first.components.get(ns)!)).toBe("overwritten");
    await later(e, rt, 2 * HOUR);
    // A root-only change: the root's old overwritten row goes, the component's stays.
    await push(e, c, new Map([[ns, comp2]]));
    expect((await states(e)).has(first.root)).toBe(false);
    expect((await states(e)).has(second.root)).toBe(false);
    const inComponent = await states(e, ns);
    expect(inComponent.get(first.components.get(ns)!)).toBe("overwritten");
    expect(inComponent.get(second.components.get(ns)!)).toBe("active");
  });
});
