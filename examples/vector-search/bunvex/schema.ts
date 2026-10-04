import { defineSchema, defineTable } from "bunvex/server";
import { v } from "bunvex/values";

/** The size of an embedding (OpenAI's text-embedding-3-small and ada-002 models). */
export const DIMENSIONS = 1536;

export default defineSchema({
  // One table: each food holds its own embedding, indexed with its cuisine as a filter.
  foods: defineTable({
    description: v.string(),
    cuisine: v.string(),
    embedding: v.array(v.float64()),
  }).vectorIndex("by_embedding", { vectorField: "embedding", dimensions: DIMENSIONS, filterFields: ["cuisine"] }),

  // Two tables: a movie is saved at once, and its embedding (computed later, by an action) in a table of its own.
  movies: defineTable({
    title: v.string(),
    description: v.string(),
    genre: v.string(),
    votes: v.number(),
    embeddingId: v.optional(v.id("movieEmbeddings")),
  }).index("by_embedding", ["embeddingId"]),
  movieEmbeddings: defineTable({
    embedding: v.array(v.float64()),
    genre: v.string(),
  }).vectorIndex("by_embedding", { vectorField: "embedding", dimensions: DIMENSIONS, filterFields: ["genre"] }),
});
