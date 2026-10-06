// The persistence interface as Convex's (STUDY-133 PR 3): each document version carries the ts of the version it
// replaces (`prev_ts`), an index entry is read with its document at the entry's own ts (the exact-ts join), an
// index backfill writes each entry at its document version's own ts, and a mutation begun before an index
// changed runs again with the new catalog.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { v } from "@bunvex/values";
import { Engine } from "../src/engine.ts";
import { internalIdOf } from "../src/internal-id.ts";
import { encodeKey, prefixEnd } from "../src/keyenc.ts";
import type { Persistence, RetentionStore } from "../src/persistence/index.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import { SqlitePersistence } from "../src/persistence/sqlite.ts";
import { defineSchema, defineTable } from "../src/schema.ts";

const dirs: string[] = [];
const engines: Engine[] = [];
afterEach(async () => {
  for (const e of engines.splice(0)) await e.close().catch(() => {});
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (name: string) => {
  const d = mkdtempSync(join(tmpdir(), "bunvex-iface-"));
  dirs.push(d);
  return join(d, name);
};
const FULL_LO = new Uint8Array(0);
const FULL_HI = Uint8Array.from([0xff, 0xff, 0xff, 0xff]);
const stores: [string, () => Promise<Persistence & RetentionStore>][] = [
  ["memory", () => MemoryPersistence.open(null, { durable: false })],
  ["sqlite", async () => new SqlitePersistence(tmp("db.sqlite"), { durable: false })],
];

describe.each(stores)("%s", (_name, make) => {
  test("prev_ts: each version of a document names the ts of the one it replaces (Convex's DocumentLogEntry)", async () => {
    const p = await make();
    const e = await new Engine(defineSchema({ items: defineTable(v.any()) }), p).init();
    engines.push(e);
    const id = await e.mutation((db) => db.insert("items", { n: 1 }));
    await e.mutation((db) => db.patch(id, { n: 2 }));
    await e.mutation((db) => db.patch(id, { n: 3 }));
    await e.mutation((db) => db.delete(id));
    const rows = (await p.readDocumentLog(0n, e.committer.visibleTs, 1e6)).filter((r) => r.id === internalIdOf(id));
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.prevTs)).toEqual([null, rows[0]!.ts, rows[1]!.ts, rows[2]!.ts]);
    expect(rows.map((r) => r.deleted)).toEqual([false, false, false, true]);
  });

  test("the exact-ts join: an entry is read with its document's version at the entry's own ts", async () => {
    const p = await make();
    // Raw writes: an entry at ts 10, then a newer version of its document at ts 20 that does not touch it.
    const table = "AAAAAAAAAAAAAAAAAAAAAQ";
    const index = "AAAAAAAAAAAAAAAAAAAAAg";
    const doc = "AAAAAAAAAAAAAAAAAAAAAw";
    const key = encodeKey(["k"]);
    if ("acquireLease" in p) await (p as any).acquireLease({ holder: "t", ttlMs: 60_000 });
    p.apply(10n, [{ table, id: doc, json: `{"v":1}`, prevTs: null }], [{ index, key, table, id: doc }]);
    p.apply(20n, [{ table, id: doc, json: `{"v":2}`, prevTs: 10n }], []);
    await p.flush();
    expect(await p.scan(table, index, FULL_LO, FULL_HI, 20n, 10, false)).toEqual([
      { id: doc, ts: 10n, json: `{"v":1}` },
    ]);
    // `get` is the newest version at or below the snapshot.
    expect(await p.get(table, doc, 20n)).toEqual({ json: `{"v":2}`, ts: 20n });
    expect(await p.get(table, doc, 15n)).toEqual({ json: `{"v":1}`, ts: 10n });
    await p.close();
  });
});

describe("index backfill at each document's own ts (DV-127 reversed)", () => {
  test("a backfilled entry is at its document version's ts, below the index's creation", async () => {
    const path = tmp("log");
    const plain = defineSchema({ items: defineTable(v.any()) });
    const indexed = defineSchema({ items: defineTable(v.any()).index("by_n", ["n"]) });
    const e1 = await new Engine(plain, await MemoryPersistence.open(path, { durable: false })).init();
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) ids.push(await e1.mutation((db) => db.insert("items", { n: i })));
    await e1.mutation((db) => db.patch(ids[3]!, { n: 103 }));
    const t1 = e1.catalog.table("items");
    const versions = await Promise.all(
      ids.map((id) => e1.persistence.get(t1.id, internalIdOf(id), e1.committer.visibleTs)),
    );
    await e1.close();
    const p = await MemoryPersistence.open(path, { durable: false });
    const e = await new Engine(indexed, p).init();
    engines.push(e);
    await e.indexesReady();
    const t = e.catalog.table("items");
    const ix = t.indexes.get("by_n")!;
    for (const [i, id] of ids.entries()) {
      const at = versions[i]!.ts; // the version's own ts: before the index existed
      const k = encodeKey([i === 3 ? 103 : i]);
      const got = await p.scan(t.id, ix.id, k, prefixEnd(k), at, 10, false);
      expect(got.map((g) => [g.id, g.ts])).toEqual([[internalIdOf(id), at]]);
    }
    // ids[3]'s first version (n = 3) never had an entry: only its version at the snapshot is indexed.
    const k3 = encodeKey([3]);
    expect(await p.scan(t.id, ix.id, k3, prefixEnd(k3), e.committer.visibleTs, 10, false)).toEqual([]);
  });
});

describe("a mutation begun before an index changed (catalogTouches)", () => {
  test("it conflicts, runs again with the new catalog, and its write is in the new index", async () => {
    const e = await new Engine(defineSchema({}), new SqlitePersistence(tmp("db.sqlite"), { durable: false }), {
      storedSchema: true,
      indexBackfill: { chunkRate: null },
    }).init();
    engines.push(e);
    const pushed = async (schema: ReturnType<typeof defineSchema>) => {
      const push = await e.startSchemaPush(schema);
      for (let i = 0; i < 400 && (await e.schemaPushStatus(push.schemaId)).type !== "complete"; i++) await Bun.sleep(5);
      await e.commitSchemaPush(push.schemaId, async () => {});
    };
    await pushed(defineSchema({ items: defineTable(v.any()) }));
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) ids.push(await e.mutation((db) => db.insert("items", { n: i })));
    let release!: () => void;
    const gate = new Promise<void>((ok) => {
      release = ok;
    });
    let entered!: () => void;
    const inside = new Promise<void>((ok) => {
      entered = ok;
    });
    let runs = 0;
    const m = e.mutation(async (db) => {
      runs++;
      await db.get(ids[5]!);
      if (runs === 1) {
        entered();
        await gate;
      }
      await db.patch(ids[5]!, { n: 999 });
    });
    await inside;
    // The index is created, built and enabled while the mutation waits with the old catalog.
    await pushed(defineSchema({ items: defineTable(v.any()).index("by_n", ["n"]) }));
    release();
    await m;
    expect(runs).toBe(2);
    const found = await e.query((db) =>
      db
        .query("items")
        .withIndex("by_n", (q) => q.eq("n", 999))
        .collect(),
    );
    expect(found.map((d) => d._id)).toEqual([ids[5]]);
  });
});
