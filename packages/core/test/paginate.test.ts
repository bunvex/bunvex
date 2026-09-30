import { describe, expect, test } from "bun:test";
import { v } from "@bunvex/values";
import { Engine } from "../src/engine.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import { type Doc, defineSchema, defineTable } from "../src/schema.ts";
import { Subscriptions } from "../src/subscriptions.ts";

async function engine(n = 0) {
  const schema = defineSchema({ items: defineTable(v.any()).index("by_n", ["n"]) });
  const e = await new Engine(schema, await MemoryPersistence.open(null, { durable: false }), {
    instanceSecret: "s1",
  }).init();
  if (n)
    await e.mutation(async (db) => {
      for (let i = 0; i < n; i++) await db.insert("items", { n: i });
    });
  return e;
}
const ns = (docs: Doc[]) => docs.map((d) => d.n);
const page = (e: Engine, cursor: string | null, numItems: number, extra: Record<string, unknown> = {}) =>
  e.query((db) =>
    db
      .query("items")
      .withIndex("by_n")
      .paginate({ numItems, cursor, ...extra }),
  );

describe(".paginate(), as Convex (STUDY-17)", () => {
  test("pages through the range; a full page is not done even at the end", async () => {
    const e = await engine(250);
    const p1 = await page(e, null, 100);
    const p2 = await page(e, p1.continueCursor, 100);
    const p3 = await page(e, p2.continueCursor, 100);
    expect([p1.page.length, p2.page.length, p3.page.length]).toEqual([100, 100, 50]);
    expect([p1.isDone, p2.isDone, p3.isDone]).toEqual([false, false, true]);
    expect(ns(p2.page)[0]).toBe(100);
    const f = await engine(200);
    const a = await page(f, null, 100);
    const b = await page(f, a.continueCursor, 100);
    const c = await page(f, b.continueCursor, 100);
    expect([b.isDone, c.page.length, c.isDone]).toEqual([false, 0, true]);
    const again = await page(f, c.continueCursor, 100); // paging past the end stays done
    expect([again.page.length, again.isDone]).toEqual([0, true]);
  });

  test("descending, with a range and a filter", async () => {
    const e = await engine(50);
    const q = (cursor: string | null) =>
      e.query((db) =>
        db
          .query("items")
          .withIndex("by_n", (r) => r.lt("n", 40))
          .order("desc")
          .filter((x) => x.eq(x.mod(x.field("n"), 2), 0))
          .paginate({ numItems: 5, cursor }),
      );
    const a = await q(null);
    const b = await q(a.continueCursor);
    expect(ns(a.page)).toEqual([38, 36, 34, 32, 30]);
    expect(ns(b.page)).toEqual([28, 26, 24, 22, 20]);
  });

  test("cursors are opaque and bound to their query and instance", async () => {
    const e = await engine(10);
    const a = await page(e, null, 3);
    await expect(
      e.query((db) =>
        db.query("items").withIndex("by_n").order("desc").paginate({ numItems: 3, cursor: a.continueCursor }),
      ),
    ).rejects.toThrow(
      "InvalidCursor: Tried to run a query starting from a cursor, but it looks like this cursor is from a different query.",
    );
    await expect(page(e, `${a.continueCursor}x`, 3)).rejects.toThrow("InvalidCursor: Failed to parse cursor");
    const other = await new Engine(e.schema, e.persistence, { instanceSecret: "s2" }).init();
    await expect(page(other, a.continueCursor, 3)).rejects.toThrow("Failed to parse cursor");
  });

  test("argument errors and one paginated query per function", async () => {
    const e = await engine(3);
    await expect(page(e, null, 0)).rejects.toThrow("`options.numItems` must be a positive number. Received `0`.");
    await expect(page(e, null, 40_000)).rejects.toThrow("Requested too many items: 40000");
    await expect(page(e, null, 2, { maximumRowsRead: 0 })).rejects.toThrow(
      "maximumRowsRead and maximumBytesRead must be greater than 0",
    );
    await expect(
      e.query(async (db) => {
        await db.query("items").paginate({ numItems: 1, cursor: null });
        return db.query("items").paginate({ numItems: 1, cursor: null });
      }),
    ).rejects.toThrow("ran multiple paginated queries");
  });

  test("maximumRowsRead stops the page early with SplitRequired, and paging continues", async () => {
    const e = await engine(100);
    const a = await page(e, null, 80, { maximumRowsRead: 30 });
    expect(a.page.length).toBe(30);
    expect(a.pageStatus).toBe("SplitRequired");
    expect(a.splitCursor).not.toBeNull();
    const b = await page(e, a.continueCursor, 80);
    expect(ns(b.page)[0]).toBe(30);
  });

  test("a pinned page stopped by maximumRowsRead still continues at its end, so its split covers it all", async () => {
    const e = await engine(20);
    const whole = await page(e, null, 20);
    const a = await page(e, null, 20, { endCursor: whole.continueCursor, maximumRowsRead: 8 });
    expect(a.page.length).toBe(8);
    expect(a.pageStatus).toBe("SplitRequired");
    expect(a.continueCursor).toBe(whole.continueCursor); // Convex: end_cursor.or_else(query.cursor())
    const first = await page(e, null, 20, { endCursor: a.splitCursor });
    const second = await page(e, a.splitCursor ?? null, 20, { endCursor: a.continueCursor });
    expect([...ns(first.page), ...ns(second.page)]).toEqual(ns(whole.page));
  });

  test("an explicit endCursor returns exactly the page up to it", async () => {
    const e = await engine(20);
    const a = await page(e, null, 5);
    await e.mutation((db) => db.insert("items", { n: 2.5 })); // lands inside the first page
    const again = await page(e, null, 5, { endCursor: a.continueCursor });
    expect(ns(again.page)).toEqual([0, 1, 2, 2.5, 3, 4]);
    expect(again.continueCursor).toBe(a.continueCursor);
  });

  test("a subscribed page keeps its boundary across re-runs (the journal)", async () => {
    const e = await engine(10);
    const published: Doc[][] = [];
    const subs = new Subscriptions(e, (_k, m) => {
      if ("value" in m) published.push(JSON.parse(m.value).page);
    });
    await subs.subscribe("p", (db) => db.query("items").withIndex("by_n").paginate({ numItems: 3, cursor: null }));
    await e.mutation((db) => db.insert("items", { n: 0.5 }));
    await new Promise((r) => setTimeout(r, 20));
    expect(published.map((p) => p.map((d) => d.n))).toEqual([
      [0, 1, 2],
      [0, 0.5, 1, 2], // grew inside the page instead of pushing 2 out
    ]);
  });
});
