// The anonymous method's one function (STUDY-201 §1.8, STUDY-208 §1.14), v2.0.0's: it records an anonymous user's
// account, the app user id the core made for it (`c9b399d3`).
import { v } from "@bunvex/values";
import { mutation } from "./_generated/server.ts";

/** Record the account of an anonymous app user. */
export const createAnonymousAccount = mutation({
  args: { userId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert("accounts", args);
    return null;
  },
});
