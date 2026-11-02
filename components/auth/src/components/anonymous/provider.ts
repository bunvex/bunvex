// The anonymous method's one function (STUDY-201 §1.8), v2's: no arguments and, as v2's, no `returns` validator.
import { mutation } from "./_generated/server.ts";

/** Create an anonymous account: a random UUID (from the mutation's seeded stream), stored and returned. */
export const createAnonymousAccount = mutation({
  args: {},
  handler: async (ctx) => {
    const anonymousId = crypto.randomUUID();
    await ctx.db.insert("accounts", { anonymousId });
    return anonymousId;
  },
});
