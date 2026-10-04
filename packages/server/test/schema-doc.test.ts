// `schema.doc(table)`, `schema.id(table)` and `docValidator(table, definition)`, as Convex's (STUDY-66 §6):
// a table's validator with `_id` and `_creationTime` added (to each member of a union), for `args` and
// `returns`; a table the schema does not have is Convex's error.
import { describe, expect, test } from "bun:test";
import { type DataModelFromSchemaDefinition, defineSchema, defineTable, docValidator, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { type GenericId, type Infer, v } from "@bunvex/values";
import { Functions, mutation, query } from "../src/functions.ts";

const schema = defineSchema({
  messages: defineTable({ author: v.string(), body: v.optional(v.string()) }),
  shapes: defineTable(
    v.union(v.object({ kind: v.literal("circle"), r: v.number() }), v.object({ kind: v.literal("dot") })),
  ),
  anything: defineTable(v.any()),
});

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const check = <T extends true>(_: T) => {};
// The types: the document type of the table, system fields included.
const messageDoc = schema.doc("messages");
check<
  Equal<Infer<typeof messageDoc>, { _id: GenericId<"messages">; _creationTime: number; author: string; body?: string }>
>(true);
check<Equal<Infer<ReturnType<typeof schema.id<"shapes">>>, GenericId<"shapes">>>(true);
// @ts-expect-error: not a table of the schema
() => schema.doc("nope");
type DM = DataModelFromSchemaDefinition<typeof schema>;
check<Equal<DM["messages"]["document"], Infer<typeof messageDoc>>>(true);

describe("schema.doc / schema.id / docValidator", () => {
  test("the validators: system fields after the table's own, unions per member, v.any() as it is", () => {
    expect(Object.keys((messageDoc as unknown as { fields: object }).fields)).toEqual([
      "author",
      "body",
      "_id",
      "_creationTime",
    ]);
    // docValidator on a definition is schema.doc on the schema's.
    const shapes = defineTable(
      v.union(v.object({ kind: v.literal("circle"), r: v.number() }), v.object({ kind: v.literal("dot") })),
    );
    expect(schema.doc("shapes").json).toEqual(docValidator("shapes", shapes).json);
    const union = schema.doc("shapes").json as { type: string; value: { value: Record<string, unknown> }[] };
    expect(union.type).toBe("union");
    for (const m of union.value) expect(Object.keys(m.value)).toEqual(expect.arrayContaining(["_id", "_creationTime"]));
    expect(schema.doc("anything").json).toEqual({ type: "any" });
    expect(schema.id("messages").json).toEqual({ type: "id", tableName: "messages" });
    expect(defineTable({ a: v.string() }).validator.json).toEqual(v.object({ a: v.string() }).json);
  });

  test("a table the schema does not have: Convex's error", () => {
    const loose = schema as unknown as { doc(t: string): unknown; id(t: string): unknown };
    const msg = 'Table "nope" is not in this schema. Tables in this schema: messages, shapes, anything';
    expect(() => loose.doc("nope")).toThrow(msg);
    expect(() => loose.id("nope")).toThrow(msg);
    // Not an inherited property either.
    expect(() => loose.doc("toString")).toThrow('Table "toString" is not in this schema.');
  });

  test("in args and returns: whole documents pass, others are refused", async () => {
    const engine = await new Engine(schema, await MemoryPersistence.open(null, { durable: false })).init();
    const fns = new Functions(engine).register("m", {
      add: mutation(({ db }) => db.insert("messages", { author: "ada" })),
      get: query({
        args: { id: schema.id("messages") },
        returns: v.union(schema.doc("messages"), v.null()),
        handler: ({ db }, { id }) => db.get(id),
      }),
      echo: query({ args: { doc: schema.doc("messages") }, handler: (_ctx, { doc }) => doc.author }),
      bad: query({ args: {}, returns: schema.doc("messages"), handler: () => ({ author: "ada" }) as never }),
    });
    const id = (await fns.runMutation("m:add", {})) as string;
    expect(await fns.runQuery("m:get", { id })).toMatchObject({ _id: id, author: "ada" });
    const doc = (await fns.runQuery("m:get", { id })) as Record<string, unknown>;
    expect(await fns.runQuery("m:echo", { doc })).toBe("ada");
    await expect(fns.runQuery("m:echo", { doc: { author: "ada" } })).rejects.toThrow("ArgumentValidationError");
    await expect(fns.runQuery("m:bad", {})).rejects.toThrow("ReturnsValidationError");
    // Schema helpers do not change what the engine reads from the schema.
    expect(Object.keys(schema)).toEqual(["tables", "schemaValidation"]);
  });
});
