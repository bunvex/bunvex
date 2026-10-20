// The app of the `server/stream` tests (test/server/stream.test.ts, stream.flatmap.test.ts): the tables of
// convex-helpers' `stream.test.ts` and `stream.flatmap.test.ts` in one schema. Upstream defines a schema per test;
// here the tables of each have names of their own (`undefinedNumbers` and `undefinedStrings` are its two `foo`s with
// an optional field).
import { defineSchema, defineTable } from "@bunvex/server";
import { v } from "@bunvex/values";

export default defineSchema({
  foo: defineTable({ a: v.number(), b: v.number(), c: v.number() })
    .index("abc", ["a", "b", "c"])
    .index("ac", ["a", "c"]),
  bar: defineTable({ c: v.number(), d: v.number(), e: v.number() }).index("cde", ["c", "d", "e"]),
  companies: defineTable({}),
  contacts: defineTable({ companyId: v.id("companies"), createdAt: v.number() }).index("by_company_createdAt", [
    "companyId",
    "createdAt",
  ]),
  a: defineTable({ a: v.number() }).index("a", ["a"]),
  b: defineTable({ b: v.number() }).index("b", ["b"]),
  c: defineTable({ c: v.number() }).index("c", ["c"]),
  undefinedNumbers: defineTable({ a: v.optional(v.number()), b: v.number() }).index("ab", ["a", "b"]),
  undefinedStrings: defineTable({ a: v.optional(v.string()), b: v.number() }).index("ab", ["a", "b"]),
  groups: defineTable({ position: v.number() }).index("position", ["position"]),
  rows: defineTable({ groupId: v.id("groups"), position: v.number() }).index("group_position", ["groupId", "position"]),
});
