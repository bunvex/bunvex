// PERSIST-01 C15: an index entry whose document is not there at the entry's own ts (the exact-ts join) is a
// corrupt store. A read raises it, as Convex does ("Dangling index reference", crates/sqlite/src/lib.rs),
// instead of skipping the entry — which also cut a query short, since a short page ends the range.
import { describe, expect, test } from "bun:test";
import { v } from "@bunvex/values";
import { OutOfRetentionError } from "../src/committer.ts";
import { PersistenceReadError } from "../src/determinism.ts";
import { Engine } from "../src/engine.ts";
import { internalIdOf } from "../src/internal-id.ts";
import { DanglingReferenceError, type Persistence } from "../src/persistence/index.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import type { Retention } from "../src/retention.ts";
import { defineSchema, defineTable } from "../src/schema.ts";

const schema = defineSchema({ items: defineTable(v.any()).index("by_n", ["n"]) });

/**
 * A store whose `scan` finds no document for the entry of `lost` (a document id), as a store whose version at the
 * entry's ts is gone; `onLost` runs when it does.
 */
function losing(p: Persistence, lost: { id: string | null }, onLost = () => {}): Persistence {
  return new Proxy(p, {
    get(target, prop) {
      if (prop === "scan")
        return async (
          table: string,
          index: string,
          lo: Uint8Array,
          hi: Uint8Array,
          ts: bigint,
          limit: number,
          desc: boolean,
        ) => {
          const rows = await target.scan(table, index, lo, hi, ts, limit, desc);
          const gone = lost.id === null ? undefined : rows.find((r) => r.id === internalIdOf(lost.id!));
          if (!gone) return rows;
          onLost();
          throw new DanglingReferenceError(index, gone.id, gone.ts, false);
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
    // A real store: the document's version at its entries' ts is removed (as a corrupt store would lose it).
    const p = await MemoryPersistence.open(null, { durable: false });
    const e = await new Engine(schema, p).init();
    const ids: string[] = [];
    for (let i = 0; i < 200; i++) ids.push(await e.mutation((db) => db.insert("items", { n: i })));
    const t = e.catalog.table("items");
    const version = p.get(t.id, internalIdOf(ids[10]!), e.committer.visibleTs)!;
    // inside the first page of 64: skipping it ended the whole range there (63 of 200)
    p.pruneDocuments([{ table: t.id, id: internalIdOf(ids[10]!), ts: version.ts }], 0n);
    // A store failure under a function is a system error (#273): the store's error is its cause.
    const err = await e.query((db) => db.query("items").withIndex("by_n").collect()).catch((x) => x);
    expect(err).toBeInstanceOf(PersistenceReadError);
    const cause = (err as Error).cause as DanglingReferenceError;
    expect(cause).toBeInstanceOf(DanglingReferenceError);
    expect(String(cause)).toContain("Dangling index reference");
    expect(cause.id).toBe(internalIdOf(ids[10]!));
    expect(cause.ts).toBe(version.ts); // the entry's own ts
    // A range that does not reach it reads normally.
    const head = await e.query((db) =>
      db
        .query("items")
        .withIndex("by_n", (q) => q.lt("n", 10))
        .collect(),
    );
    expect(head.map((d) => d._id)).toEqual(ids.slice(0, 10));
  });

  test("the error of a store's scan reaches the query", async () => {
    const { e } = await seeded(3, (p) => p);
    e.persistence.scan = async (_t, index, _lo, _hi, ts) => {
      throw new DanglingReferenceError(index, "x", ts, true);
    };
    // a store failure under a function is a system error (#273): the store's error is its cause
    const err = await e.query((db) => db.query("items").collect()).catch((x) => x);
    expect(err).toBeInstanceOf(PersistenceReadError);
    expect((err as Error).cause).toBeInstanceOf(DanglingReferenceError);
    expect(String(err)).toContain("Index reference to deleted document");
  });

  test("a remote store's reference that retention pruned during the read is out of retention, not a store failure", async () => {
    let pruned = false;
    const { e } = await seeded(3, (p) => p);
    e.persistence.scan = async (_t, index, _lo, _hi, ts) => {
      pruned = true;
      throw new DanglingReferenceError(index, "x", ts, true);
    };
    e.retention = {
      check(ts: bigint) {
        if (pruned) throw new OutOfRetentionError(ts, ts + 1n, `out of the window: ${ts}`);
      },
      stop: async () => {},
    } as unknown as Retention;
    const err = await e.query((db) => db.query("items").collect()).catch((x) => x);
    expect(err).toBeInstanceOf(OutOfRetentionError);
  });

  test("a document pruned by retention during the read is a snapshot out of the window, not a corrupt store", async () => {
    const lost = { id: null as string | null };
    let pruned = false;
    const { e, ids } = await seeded(5, (p) => losing(p, lost, () => (pruned = true)));
    e.retention = {
      check(ts: bigint) {
        if (pruned) throw new OutOfRetentionError(ts, ts + 1n, `out of the window: ${ts}`);
      },
      stop: async () => {},
    } as unknown as Retention;
    lost.id = ids[2];
    const err = await e.query((db) => db.query("items").collect()).catch((x) => x);
    expect(err).toBeInstanceOf(OutOfRetentionError);
  });
});
