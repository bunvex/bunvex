import { v } from "bunvex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { action, internalMutation, internalQuery, query } from "./_generated/server";
import { embed } from "./embed";

export const CUISINES = ["american", "french", "indian", "italian", "japanese", "mexican", "thai"];

const SAMPLES = [
  { cuisine: "italian", description: "Spaghetti tossed with pecorino cheese and cracked black pepper." },
  { cuisine: "indian", description: "A spicy chicken curry with coconut, chillies and fennel seeds." },
  { cuisine: "japanese", description: "A rice bowl of chicken and egg simmered in soy broth." },
  { cuisine: "mexican", description: "Spit-grilled pork tacos with pineapple and onion." },
  { cuisine: "french", description: "Roast duck served in a rich red wine sauce." },
];

export type FoodResult = { _id: Id<"foods">; _score: number; description: string; cuisine: string };

/** Add the sample foods, each with its embedding. */
export const populate = action({
  args: {},
  handler: async (ctx) => {
    for (const food of SAMPLES)
      await ctx.runMutation(internal.foods.insertRow, { ...food, embedding: await embed(food.description) });
  },
});

/** Add a food: its embedding first (an action can call OpenAI), then the row. */
export const insert = action({
  args: { cuisine: v.string(), description: v.string() },
  handler: async (ctx, args) => {
    await ctx.runMutation(internal.foods.insertRow, { ...args, embedding: await embed(args.description) });
  },
});

export const insertRow = internalMutation({
  args: { description: v.string(), cuisine: v.string(), embedding: v.array(v.float64()) },
  handler: async (ctx, args) => {
    if (!CUISINES.includes(args.cuisine)) throw new Error(`Unknown cuisine: ${args.cuisine}`);
    await ctx.db.insert("foods", args);
  },
});

/** The 10 newest foods. */
export const list = query({
  args: {},
  handler: async (ctx) =>
    (await ctx.db.query("foods").order("desc").take(10)).map(({ _id, description, cuisine }) => ({
      _id,
      description,
      cuisine,
    })),
});

/** The foods closest in meaning to `query`, optionally of some cuisines only. */
export const similar = action({
  args: { query: v.string(), cuisines: v.optional(v.array(v.string())) },
  handler: async (ctx, { query, cuisines }): Promise<FoodResult[]> => {
    const vector = await embed(query);
    const results = await ctx.vectorSearch("foods", "by_embedding", {
      vector,
      limit: 16,
      ...(cuisines ? { filter: (q) => q.or(...cuisines.map((c) => q.eq("cuisine", c))) } : {}),
    });
    // A vector search returns ids and scores; the documents come from a query.
    return await ctx.runQuery(internal.foods.withScores, { results });
  },
});

export const withScores = internalQuery({
  args: { results: v.array(v.object({ _id: v.id("foods"), _score: v.float64() })) },
  handler: async (ctx, { results }) => {
    const out: FoodResult[] = [];
    for (const { _id, _score } of results) {
      const food = await ctx.db.get(_id);
      if (food) out.push({ _id, _score, description: food.description, cuisine: food.cuisine });
    }
    return out;
  },
});
