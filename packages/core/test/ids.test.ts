import { describe, expect, test } from "bun:test";
import { decodeId } from "@bunvex/values";
import { wallClock } from "../src/determinism.ts";
import { Engine } from "../src/engine.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import { Schema } from "../src/schema.ts";

async function engine() {
  const schema = new Schema().table("users", {}).table("posts", {});
  return new Engine(schema, await MemoryPersistence.open(null, { durable: false })).init();
}

describe("ids created by the engine", () => {
  test("carry the table number and the day, like Convex's generator", async () => {
    const e = await engine();
    const [u, p] = await e.mutation(async (db) => [await db.insert("users", {}), await db.insert("posts", {})]);
    const du = decodeId(u);
    expect(u).toHaveLength(32);
    expect(du.tableNumber).toBe(e.catalog.table("users").number);
    expect(decodeId(p).tableNumber).toBe(e.catalog.table("posts").number);
    expect((du.internalId[14] << 8) | du.internalId[15]).toBe(Math.floor(wallClock() / 86_400_000));
    expect(await e.query((db) => db.get("users", u))).toMatchObject({ _id: u });
  });

  test("an id of another table is refused; a malformed one too; an unknown table reads as null", async () => {
    const e = await engine();
    const p = await e.mutation((db) => db.insert("posts", { t: 1 }));
    await expect(e.query((db) => db.get("users", p))).rejects.toThrow(
      'Invalid argument `id` for `db.get`: expected to be an Id<"users">, got Id<"posts"> instead.',
    );
    await expect(e.mutation((db) => db.patch("users", p, { t: 2 }))).rejects.toThrow(
      'Invalid argument `id` for `db.patch`: expected to be an Id<"users">, got Id<"posts"> instead.',
    );
    await expect(e.mutation((db) => db.delete("users", p))).rejects.toThrow("for `db.delete`");
    await expect(e.query((db) => db.get("users", "not-an-id"))).rejects.toThrow(
      "Invalid argument `id` for `db.get`: Unable to decode ID: Invalid ID length 9",
    );
    // A well-formed id of a table that does not exist (number 10999).
    const { encodeId } = await import("@bunvex/values");
    expect(await e.query((db) => db.get("users", encodeId(10_999, new Uint8Array(16))))).toBeNull();
  });
});
