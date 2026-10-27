// The app's calls into `child` with ids (test/component-ids.test.ts): an app id given to the component's
// `v.id("messages")`, and the component's own `notes` id coming back through `returns` and going in through `args`.
// biome-ignore-all lint/suspicious/noExplicitAny: the component's api is untyped here
import { componentsGeneric, mutationGeneric } from "convex/server";
import { v } from "convex/values";

const child = (componentsGeneric() as any).child.lib;

/** Each call's result, or its error's first line. */
const outcome = async (call: () => Promise<unknown>) => {
  try {
    return { ok: await call() };
  } catch (e) {
    return { error: (e as Error).message.split("\n")[0] };
  }
};

export const appIdToChild = mutationGeneric({
  args: { table: v.union(v.literal("items"), v.literal("messages")) },
  handler: async (ctx, { table }) => {
    const id =
      table === "items" ? await ctx.db.insert("items", { n: 1 }) : await ctx.db.insert("messages", { text: "t" });
    return outcome(() => ctx.runQuery(child.takesMessageId, { id }));
  },
});

export const childIdRoundTrip = mutationGeneric({
  args: {},
  handler: async (ctx) =>
    outcome(async () => {
      const id = await ctx.runMutation(child.newNote, {});
      return ctx.runQuery(child.takesNoteId, { id });
    }),
});
