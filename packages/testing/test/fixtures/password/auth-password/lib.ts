import { mutation, query } from "@bunvex/server";
import { hashPassword, verifyPassword } from "@bunvex/server/password";
import { v } from "@bunvex/values";

// The salt from the mutation's seeded stream, as `authPassword` draws it.
export const hash = mutation({
  args: { password: v.string() },
  handler: async (_ctx, { password }) => hashPassword(password, crypto.getRandomValues(new Uint8Array(16))),
});

export const verify = mutation({
  args: { password: v.string(), hash: v.string() },
  handler: async (_ctx, args) => verifyPassword(args.password, args.hash),
});

/** Several at once: they run off the JS thread, side by side. */
export const hashMany = mutation({
  args: { count: v.number() },
  handler: async (_ctx, { count }) =>
    Promise.all(
      Array.from({ length: count }, (_, i) => hashPassword(`pw-${i}`, crypto.getRandomValues(new Uint8Array(16)))),
    ),
});

export const hashInQuery = query({
  args: {},
  handler: async () => hashPassword("pw", new Uint8Array(16)),
});

export const shortSalt = mutation({
  args: {},
  handler: async () => hashPassword("pw", new Uint8Array(4)),
});
