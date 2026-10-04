import { describe, expect, test } from "bun:test";
import { v, valueSize } from "@bunvex/values";
import { Engine } from "../src/engine.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import { defineSchema, defineTable } from "../src/schema.ts";

async function engine(n: number, fields: Record<string, unknown> = {}) {
  const e = await new Engine(
    defineSchema({ items: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
  ).init();
  for (let done = 0; done < n; done += 1000)
    await e.mutation(async (db) => {
      for (let i = done; i < Math.min(n, done + 1000); i++) await db.insert("items", { i, ...fields });
    });
  return e;
}

describe("transaction read limits (Convex's knobs) and collect()", () => {
  test("collect() returns every row, past the old 8192 cap", async () => {
    const e = await engine(9000);
    expect(await e.query((db) => db.query("items").collect())).toHaveLength(9000);
  });

  test("more than 32000 documents read: TooManyDocumentsRead", async () => {
    const e = await engine(32_001);
    await expect(e.query((db) => db.query("items").collect())).rejects.toThrow(
      "Too many documents read in a single function execution (limit: 32000).",
    );
    expect(await e.query((db) => db.query("items").take(32_000))).toHaveLength(32_000);
  }, 60_000);

  test("more than 16 MiB read: TooManyBytesRead", async () => {
    const e = await engine(2000, { pad: "x".repeat(9000) });
    await expect(e.query((db) => db.query("items").collect())).rejects.toThrow(
      "Too many bytes read in a single function execution (limit: 16777216 bytes).",
    );
  }, 60_000);

  test("more than 4096 read intervals: TooManyReads", async () => {
    const e = await engine(1);
    const id = (await e.query((db) => db.query("items").first()))!._id;
    await expect(
      e.query(async (db) => {
        for (let i = 0; i < 4097; i++) await db.get("items", id);
      }),
    ).rejects.toThrow("Too many reads in a single function execution (limit: 4096).");
  });

  test("take(n) needs a non-negative integer; take(0) is empty", async () => {
    const e = await engine(3);
    expect(await e.query((db) => db.query("items").take(0))).toEqual([]);
    for (const bad of [-1, 1.5, Number.NaN])
      await expect(e.query((db) => db.query("items").take(bad))).rejects.toThrow(
        "Arg 1 `n` to `take` must be a non-negative integer",
      );
  });

  // As Convex's `record_read_document` (STUDY-71): what counts is each document handed out, by its size.
  test("bytes read are documents' sizes, not their JSON", async () => {
    const e = await engine(3, { s: "ab" });
    const docs = await e.query((db) => db.query("items").collect());
    const size = docs.reduce((n, d) => n + valueSize(d as never), 0);
    expect(size).toBeLessThan(docs.reduce((n, d) => n + JSON.stringify(d).length, 0));
    const read = (limit: number) =>
      e.query((db) => {
        db.limits = { ...db.limits, bytesRead: limit };
        return db.query("items").collect();
      });
    expect(await read(size)).toHaveLength(3);
    await expect(read(size - 1)).rejects.toThrow(
      `Too many bytes read in a single function execution (limit: ${size - 1} bytes).`,
    );
  });

  test("only the documents handed out count, not a page's prefetch", async () => {
    const e = await engine(200);
    const second = await e.query((db) => {
      db.limits = { ...db.limits, documentsRead: 2 };
      return db
        .query("items")
        .filter((q) => q.eq(q.field("i"), 1))
        .first();
    });
    expect(second?.i).toBe(1);
    const used = await e.query(async (db) => {
      for await (const d of db.query("items")) if (d.i === 4) break;
      return db.usage.documentsRead;
    });
    expect(used).toBe(5);
  });

  test("system tables' reads are kept apart and never limited", async () => {
    const e = await engine(2);
    const r = await e.query(async (db) => {
      db.limits = { ...db.limits, documentsRead: 2 };
      const system = await db.asSystem(() => db.query("_tables").collect());
      const user = await db.query("items").collect();
      return { system: system.length, user: user.length, used: db.usage.documentsRead };
    });
    expect(r.system).toBeGreaterThan(2);
    expect(r).toMatchObject({ user: 2, used: 2 });
  });
});
