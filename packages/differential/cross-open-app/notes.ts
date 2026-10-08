// The cross-open app's functions: write a note, and read the notes back by each kind of index.
import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import { action, internalQuery, mutation, query } from "./_generated/server";

const bodiesRef = makeFunctionReference<"query">("notes:bodies");

export const add = mutation({
  args: { body: v.string(), kind: v.string(), v: v.array(v.float64()) },
  handler: async (ctx, note) => {
    await ctx.db.insert("notes", note);
  },
});

/** Every note's body, in creation order. */
export const list = query({
  args: {},
  handler: async (ctx) => (await ctx.db.query("notes").collect()).map((n) => n.body),
});

/** The bodies of one kind, by the database index. */
export const byKind = query({
  args: { kind: v.string() },
  handler: async (ctx, { kind }) =>
    (
      await ctx.db
        .query("notes")
        .withIndex("by_kind", (q) => q.eq("kind", kind))
        .collect()
    ).map((n) => n.body),
});

/** The bodies a text search finds, sorted. */
export const search = query({
  args: { text: v.string() },
  handler: async (ctx, { text }) =>
    (
      await ctx.db
        .query("notes")
        .withSearchIndex("search_body", (q) => q.search("body", text))
        .collect()
    )
      .map((n) => n.body)
      .sort(),
});

export const bodies = internalQuery({
  args: { ids: v.array(v.id("notes")) },
  handler: async (ctx, { ids }) => Promise.all(ids.map(async (id) => (await ctx.db.get(id))?.body ?? null)),
});

/** The body of the note nearest a vector. */
export const nearest = action({
  args: { vector: v.array(v.float64()) },
  handler: async (ctx, { vector }): Promise<string | null> => {
    const [hit] = await ctx.vectorSearch("notes", "by_v", { vector, limit: 1 });
    if (!hit) return null;
    const [body] = (await ctx.runQuery(bodiesRef, { ids: [hit._id] })) as (string | null)[];
    return body ?? null;
  },
});

/** Every note whole: its id and creation time with its fields (the export/import test). */
export const all = query({
  args: {},
  handler: async (ctx) => ctx.db.query("notes").collect(),
});

/** Store a file with this text: its id. */
export const upload = action({
  args: { text: v.string() },
  handler: async (ctx, { text }) => ctx.storage.store(new Blob([text], { type: "text/plain" })),
});

/** Every stored file's metadata. */
export const files = query({
  args: {},
  handler: async (ctx) =>
    (await ctx.db.system.query("_storage").collect()).map(({ _id, _creationTime, sha256, size, contentType }) => ({
      _id,
      _creationTime,
      sha256,
      size,
      contentType,
    })),
});

/** A stored file's text, or null when it is not there. */
export const fileText = action({
  args: { id: v.id("_storage") },
  handler: async (ctx, { id }): Promise<string | null> => (await (await ctx.storage.get(id))?.text()) ?? null,
});
