// The schema of the streaming export's fallback test (STUDY-187 §2.8): a table's JSON Schema read from its
// definition when its shape is not an object. Each validator kind, a table of any document, unions of objects
// (top level and nested), and no definition for `other` (schema validation off, so it can be written).
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema(
  {
    loose: defineTable(v.any()),
    posts: defineTable({
      author: v.id("loose"),
      body: v.string(),
      n: v.optional(v.number()),
      big: v.int64(),
      bytes: v.bytes(),
      lit: v.union(v.literal("x"), v.literal(1), v.literal(true), v.literal(2n)),
      list: v.array(v.null()),
      rec: v.record(v.string(), v.boolean()),
      ids: v.record(v.id("loose"), v.any()),
      nested: v.object({ z: v.any(), y: v.optional(v.string()) }),
      either: v.union(v.string(), v.object({ k: v.string() })),
    }),
    pairs: defineTable(v.union(v.object({ k: v.string() }), v.object({ j: v.string() }))),
    deep: defineTable({ x: v.union(v.object({ k: v.string() }), v.object({ j: v.string() })) }),
  },
  { schemaValidation: false },
);
