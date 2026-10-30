// Convex Auth's `authEmail` path (`components/email/helpers.ts`): the handle to `resend`'s `lib.sendEmail` arrives as
// a string, and this component calls it with auth's arguments.
import { type FunctionHandle, mutationGeneric } from "@bunvex/server";
import { v } from "@bunvex/values";

export const sendCode = mutationGeneric({
  args: { sendEmailHandle: v.string(), apiKey: v.string(), to: v.string(), code: v.string() },
  returns: v.string(),
  handler: async (ctx, { sendEmailHandle, apiKey, to, code }) => {
    const handle = sendEmailHandle as FunctionHandle<"mutation">;
    return (await ctx.runMutation(handle, {
      options: { apiKey, testMode: false, initialBackoffMs: 30000, retryAttempts: 5 },
      from: "auth@example.com",
      to: [to],
      subject: "Your code",
      text: `Your code is ${code}`,
    })) as string;
  },
});
