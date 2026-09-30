import { describe, expect, test } from "bun:test";
import { v } from "@bunvex/values";
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
});
