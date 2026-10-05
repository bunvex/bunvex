// The typed database (STUDY-36): tables, ids, documents, index names and fields, field paths — checked by
// `tsc`; the runtime test makes the same calls through the typed view of a real transaction.
import { expect, test } from "bun:test";
import { type GenericId, v } from "@bunvex/values";
import type { DataModelFromSchemaDefinition } from "../../src/data-model.ts";
import type { GenericDatabaseReader, GenericDatabaseWriter } from "../../src/database-types.ts";
import { Engine } from "../../src/engine.ts";
import { MemoryPersistence } from "../../src/persistence/memory.ts";
import { defineSchema, defineTable } from "../../src/schema.ts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const check = <T extends true>(_: T) => {};

const schema = defineSchema({
  users: defineTable({ name: v.string(), age: v.number(), address: v.optional(v.object({ city: v.string() })) }).index(
    "by_name_age",
    ["name", "age"],
  ),
  messages: defineTable({ author: v.id("users"), body: v.string() }).index("by_author", ["author"]),
});
type DM = DataModelFromSchemaDefinition<typeof schema>;

// Type-level checks against a typed database (never run: the async function is only type-checked).
async function typed(db: GenericDatabaseWriter<DM>, reader: GenericDatabaseReader<DM>) {
  const userId = await db.insert("users", { name: "ada", age: 36 });
  check<Equal<typeof userId, GenericId<"users">>>(true);
  // @ts-expect-error a missing field
  await db.insert("users", { name: "ada" });
  // @ts-expect-error system fields are not written
  await db.insert("users", { name: "ada", age: 1, _id: userId });
  // @ts-expect-error not a table
  await db.insert("nope", {});
  const user = await db.get(userId);
  check<Equal<NonNullable<typeof user>["name"], string>>(true);
  const again = await db.get("users", userId);
  check<Equal<typeof again, typeof user>>(true);
  const messageId = await db.insert("messages", { author: userId, body: "hi" });
  // @ts-expect-error a messages id where a users id is wanted
  await db.insert("messages", { author: messageId, body: "hi" });
  await db.patch(userId, { age: 37 });
  // @ts-expect-error the wrong type for a field
  await db.patch(userId, { age: "old" });
  await db.patch("users", userId, { address: undefined });
  await db.replace(userId, { name: "ada", age: 38 });
  await db.delete(messageId);
  // Index names and fields, in order, with their values' types.
  const byName = await reader
    .query("users")
    .withIndex("by_name_age", (q) => q.eq("name", "ada").gt("age", 30))
    .collect();
  check<Equal<(typeof byName)[number]["_id"], GenericId<"users">>>(true);
  // @ts-expect-error not an index of users
  reader.query("users").withIndex("by_author");
  // @ts-expect-error `count()` is internal, as Convex's (`@internal`, so not in its published types; STUDY-107)
  await reader.query("users").count();
  // @ts-expect-error fields in index order: age before name
  reader.query("users").withIndex("by_name_age", (q) => q.eq("age", 3));
  // @ts-expect-error the value's type
  reader.query("users").withIndex("by_name_age", (q) => q.eq("name", 3));
  // Filters over field paths, nested ones included.
  const inLima = await reader
    .query("users")
    .filter((q) => q.and(q.eq(q.field("address.city"), "Lima"), q.gte(q.field("age"), 18)))
    .order("desc")
    .first();
  check<Equal<typeof inLima, DM["users"]["document"] | null>>(true);
  // @ts-expect-error not a field path of users
  reader.query("users").filter((q) => q.eq(q.field("nope"), 1));
  const page = await reader.query("messages").paginate({ numItems: 10, cursor: null });
  check<Equal<(typeof page.page)[number]["body"], string>>(true);
  const file = await reader.system.get("_storage", "x" as GenericId<"_storage">);
  check<Equal<NonNullable<typeof file>["size"], number>>(true);
  for await (const m of reader.query("messages")) check<Equal<typeof m.author, GenericId<"users">>>(true);
}
void typed;

test("the typed calls run on the engine's transaction", async () => {
  const engine = await new Engine(schema, await MemoryPersistence.open(null, { durable: false })).init();
  const id = await engine.mutation(async (tx) => {
    const db = tx as unknown as GenericDatabaseWriter<DM>;
    const u = await db.insert("users", { name: "ada", age: 36, address: { city: "Lima" } });
    await db.insert("messages", { author: u, body: "hi" });
    await db.patch("users", u, { age: 37 });
    return u;
  });
  const r = await engine.query(async (tx) => {
    const db = tx as unknown as GenericDatabaseReader<DM>;
    return {
      byIndex: await db
        .query("users")
        .withIndex("by_name_age", (q) => q.eq("name", "ada").gte("age", 30).lt("age", 40))
        .collect(),
      byFilter: await db
        .query("users")
        .filter((q) => q.eq(q.field("address.city"), "Lima"))
        .unique(),
      got: await db.get("users", id),
    };
  });
  expect(r.byIndex.map((u) => u.age)).toEqual([37]);
  expect(r.byFilter?._id).toBe(id);
  expect(r.got?.name).toBe("ada");
  await engine.close();
});
