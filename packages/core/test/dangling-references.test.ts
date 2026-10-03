// PERSIST-01 C15: an index entry whose document does not exist at the snapshot is a corrupt store. A read
// raises it, as Convex does ("Dangling index reference", crates/postgres/src/lib.rs), instead of skipping
// the entry — which also cut a query short, since a short page ends the range.
import { describe, expect, test } from "bun:test";
import { v } from "@bunvex/values";
import { OutOfRetentionError } from "../src/committer.ts";
import { Engine } from "../src/engine.ts";
import { DanglingReferenceError, type Persistence, type ScanDocs } from "../src/persistence/index.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import type { Retention } from "../src/retention.ts";
import { defineSchema, defineTable } from "../src/schema.ts";

const schema = defineSchema({ items: defineTable(v.any()).index("by_n", ["n"]) });

/** A store whose `get` loses the document `lost` (its index entries stay), and `onLost` runs when it does. */
function losing(p: Persistence, lost: { id: string | null }, onLost = () => {}): Persistence {
  return new Proxy(p, {
    get(target, prop) {
      if (prop === "get")
        return (table: number, id: string, ts: number) => {
          if (id !== lost.id) return target.get(table, id, ts);
          onLost();
          return null;
        };
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function seeded(n: number, wrap: (p: Persistence) => Persistence) {
  const e = await new Engine(schema, wrap(await MemoryPersistence.open(null, { durable: false }))).init();
  const ids: string[] = [];
  for (let i = 0; i < n; i++) ids.push(await e.mutation((db) => db.insert("items", { n: i })));
  return { e, ids };
}

describe("an index entry without its document (PERSIST-01 C15)", () => {
  test("a query over it raises DanglingReferenceError instead of returning fewer documents", async () => {
    const lost = { id: null as string | null };
    const { e, ids } = await seeded(200, (p) => losing(p, lost));
    lost.id = ids[10]; // inside the first page of 64: skipping it ended the whole range there (63 of 200)
    const err = await e.query((db) => db.query("items").withIndex("by_n").collect()).catch((x) => x);
    expect(err).toBeInstanceOf(DanglingReferenceError);
    expect(String(err)).toContain("Dangling index reference");
    expect((err as DanglingReferenceError).id).toBe(ids[10]);
    // A range that does not reach it reads normally.
    const head = await e.query((db) =>
      db
        .query("items")
        .withIndex("by_n", (q) => q.lt("n", 10))
        .collect(),
    );
    expect(head.map((d) => d._id)).toEqual(ids.slice(0, 10));
    lost.id = null;
    expect(await e.query((db) => db.query("items").withIndex("by_n").collect())).toHaveLength(200);
  });

  test("the error of a store's scanDocs reaches the query", async () => {
    const { e } = await seeded(3, (p) => p);
    (e.persistence as Persistence & ScanDocs).scanDocs = async (_t, index, _lo, _hi, ts) => {
      throw new DanglingReferenceError(index, "x", ts, true);
    };
    const err = await e.query((db) => db.query("items").collect()).catch((x) => x);
    expect(err).toBeInstanceOf(DanglingReferenceError);
    expect(String(err)).toContain("Index reference to deleted document");
  });

  test("a document pruned by retention during the read is a snapshot out of the window, not a corrupt store", async () => {
    const lost = { id: null as string | null };
    let pruned = false;
    const { e, ids } = await seeded(5, (p) => losing(p, lost, () => (pruned = true)));
    e.retention = {
      check(ts: number) {
        if (pruned) throw new OutOfRetentionError(ts, ts + 1, `out of the window: ${ts}`);
      },
      stop: async () => {},
    } as unknown as Retention;
    lost.id = ids[2];
    const err = await e.query((db) => db.query("items").collect()).catch((x) => x);
    expect(err).toBeInstanceOf(OutOfRetentionError);
  });
});
