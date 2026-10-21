// The schema of the triggers' test app (STUDY-181 PR 5): convex-helpers' `triggers.test.ts` schema, and the tables of
// the tests added here: `nodes` and `log` (the order recursive triggers run in), `events` (two mutations at once).
import { defineSchema, defineTable } from "@bunvex/server";
import { v } from "@bunvex/values";

const user = { firstName: v.string(), lastName: v.string(), fullName: v.string() };

export default defineSchema({
  users: defineTable(user),
  usersExplicit: defineTable(user),
  usersExplicitIncorrectTable: defineTable(user),
  userCount: defineTable({ count: v.number() }),
  nodes: defineTable({ name: v.string(), depth: v.number() }),
  log: defineTable({ entry: v.string() }),
  events: defineTable({ name: v.string(), peerArrived: v.boolean() }),
});
