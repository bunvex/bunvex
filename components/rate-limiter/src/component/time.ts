// `lib:getServerTime` (STUDY-197 §1.4): the server's clock, which `useRateLimit` reads once to measure the browser's
// skew.
import { v } from "@bunvex/values";
import { mutation } from "./_generated/server";

export const getServerTime = mutation({
  args: {},
  returns: v.number(),
  handler: async (): Promise<number> => Date.now(),
});
