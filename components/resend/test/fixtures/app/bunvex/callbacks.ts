// The app's `onEmailEvent` callback (upstream's `callbacks.onEmailEvent`): records each call in `events`.
import { vOnEmailEventArgs } from "@bunvex/resend";
import { internalMutationGeneric } from "@bunvex/server";

export const onEmailEvent = internalMutationGeneric({
  args: vOnEmailEventArgs,
  handler: async (ctx, args) => {
    await ctx.db.insert("events", args);
  },
});
