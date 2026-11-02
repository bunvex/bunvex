// The core's tables, and the app callbacks' log: upstream's fixture keeps it in module state, which the test's process
// reads; here the callbacks run in the deployment, so they write it to a table the test reads back.
import { defineSchema, defineTable } from "@bunvex/server";
import { v } from "@bunvex/values";
import core from "../../../../src/component/schema.ts";

export default defineSchema({
  ...core.tables,
  callbackCalls: defineTable({ kind: v.union(v.literal("createUser"), v.literal("onSignIn")), args: v.any() }),
});
