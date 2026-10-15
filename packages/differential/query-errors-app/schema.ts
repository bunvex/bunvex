// The app of the query start tests (STUDY-161 §5): a table with a database and a search index.
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  free: defineTable(v.any()).index("by_k", ["k"]).searchIndex("s", { searchField: "body" }),
});
