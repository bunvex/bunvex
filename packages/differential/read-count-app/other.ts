// Another module, for a nested call that resolves another module (STUDY-161 §16).
import { queryGeneric } from "convex/server";

export const q = queryGeneric({ args: {}, handler: async (ctx) => (await ctx.db.query("small").first())?._id ?? null });
