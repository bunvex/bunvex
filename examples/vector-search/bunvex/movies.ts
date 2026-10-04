import { v } from "bunvex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { action, internalAction, internalMutation, mutation, query } from "./_generated/server";
import { embed } from "./embed";

export const GENRES = ["Action", "Adventure", "Drama", "Science Fiction"];

/**
 * Add a movie: saved at once, its embedding computed afterwards by a scheduled action (a mutation cannot call
 * OpenAI), so the movie is searchable a moment later.
 */
export const insert = mutation({
  args: { title: v.string(), description: v.string(), genre: v.string() },
  handler: async (ctx, args) => {
    const movieId = await ctx.db.insert("movies", { ...args, votes: 0 });
    await ctx.scheduler.runAfter(0, internal.movies.embedMovie, { movieId, description: args.description });
    return movieId;
  },
});

export const embedMovie = internalAction({
  args: { movieId: v.id("movies"), description: v.string() },
  handler: async (ctx, { movieId, description }) => {
    await ctx.runMutation(internal.movies.saveEmbedding, { movieId, embedding: await embed(description) });
  },
});

export const saveEmbedding = internalMutation({
  args: { movieId: v.id("movies"), embedding: v.array(v.float64()) },
  handler: async (ctx, { movieId, embedding }) => {
    const movie = await ctx.db.get(movieId);
    if (!movie) return;
    const embeddingId = await ctx.db.insert("movieEmbeddings", { embedding, genre: movie.genre });
    await ctx.db.patch(movieId, { embeddingId });
  },
});

/** The 10 newest movies. */
export const list = query({
  args: {},
  handler: async (ctx) => await ctx.db.query("movies").order("desc").take(10),
});

/** The movies closest in meaning to `query`, optionally of some genres only: embedding ids and scores. */
export const similar = action({
  args: { query: v.string(), genres: v.optional(v.array(v.string())) },
  handler: async (ctx, { query, genres }) => {
    const vector = await embed(query);
    return await ctx.vectorSearch("movieEmbeddings", "by_embedding", {
      vector,
      limit: 16,
      ...(genres ? { filter: (q) => q.or(...genres.map((g) => q.eq("genre", g))) } : {}),
    });
  },
});

/** The movies of a search's results, with their scores, live (votes change). */
export const withScores = query({
  args: { results: v.array(v.object({ _id: v.id("movieEmbeddings"), _score: v.float64() })) },
  handler: async (ctx, { results }) => {
    const out: (Doc<"movies"> & { _score: number })[] = [];
    for (const { _id, _score } of results) {
      const movie = await ctx.db
        .query("movies")
        .withIndex("by_embedding", (q) => q.eq("embeddingId", _id))
        .unique();
      if (movie) out.push({ ...movie, _score });
    }
    return out;
  },
});

export const vote = mutation({
  args: { id: v.id("movies"), delta: v.union(v.literal(1), v.literal(-1)) },
  handler: async (ctx, { id, delta }) => {
    const movie = await ctx.db.get(id);
    if (movie) await ctx.db.patch(id, { votes: movie.votes + delta });
  },
});

/** Add a few movies. */
export const populate = action({
  args: {},
  handler: async (ctx) => {
    const samples = [
      { title: "Dream Heist", genre: "Action", description: "Thieves steal secrets by entering people's dreams." },
      { title: "Prison Years", genre: "Drama", description: "Two prisoners become friends over many years." },
      { title: "Ring Quest", genre: "Adventure", description: "A small hero travels far to destroy a magic ring." },
      { title: "Simulated", genre: "Science Fiction", description: "A hacker learns reality is a machine simulation." },
    ];
    for (const movie of samples) await ctx.runMutation(internal.movies.insertInternal, movie);
  },
});

export const insertInternal = internalMutation({
  args: { title: v.string(), description: v.string(), genre: v.string() },
  handler: async (ctx, args) => {
    const movieId = await ctx.db.insert("movies", { ...args, votes: 0 });
    await ctx.scheduler.runAfter(0, internal.movies.embedMovie, { movieId, description: args.description });
  },
});
