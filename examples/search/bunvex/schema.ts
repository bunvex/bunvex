import { defineSchema, defineTable } from "bunvex/server";
import { v } from "bunvex/values";

export default defineSchema({
  messages: defineTable({ author: v.string(), body: v.string() }).searchIndex("search_body", {
    searchField: "body",
  }),
});
