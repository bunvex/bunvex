// The app of test/error-frames.test.ts: engine-thrown errors (db.*, the scheduler, nested calls) in a mutation and
// a V8 action, left uncaught, caught and returned (`message`, `stack`), and logged.
import { actionGeneric, makeFunctionReference, mutationGeneric } from "convex/server";
import { v } from "convex/values";

// biome-ignore lint/suspicious/noExplicitAny: the app's own cases, typed loosely
type Ctx = any;
export const cases: Record<string, (ctx: Ctx) => Promise<unknown>> = {
  patchCreationTime: async (ctx) => {
    const id = await ctx.db.insert("items", { k: 1 });
    await ctx.db.patch(id, { _creationTime: 1 });
  },
  replaceId: async (ctx) => {
    const id = await ctx.db.insert("items", { k: 1 });
    const other = await ctx.db.insert("items", { k: 2 });
    await ctx.db.replace(id, { _id: other });
  },
  systemTable: async (ctx) => {
    await ctx.db.insert("_storage", {});
  },
  badId: async (ctx) => {
    await ctx.db.get("nope");
  },
  dollarField: async (ctx) => {
    await ctx.db.insert("items", { $x: 1 });
  },
  scheduleMissing: async (ctx) => {
    await ctx.scheduler.runAfter(0, makeFunctionReference<"mutation">("nope:x"), {});
  },
};
export const actionCases: Record<string, (ctx: Ctx) => Promise<unknown>> = {
  runQueryMissing: async (ctx) => {
    await ctx.runQuery(makeFunctionReference<"query">("nope:x"), {});
  },
  scheduleMissing: cases.scheduleMissing!,
};

export const uncaught = mutationGeneric({
  args: { c: v.string() },
  handler: async (ctx, { c }) => {
    await cases[c]!(ctx);
  },
});
export const caught = mutationGeneric({
  args: { c: v.string() },
  handler: async (ctx, { c }) => {
    try {
      await cases[c]!(ctx);
    } catch (e) {
      const err = e as Error;
      console.log(err);
      console.log(String(err.stack));
      return { name: err.name, message: err.message, stack: String(err.stack) };
    }
  },
});
export const actionUncaught = actionGeneric({
  args: { c: v.string() },
  handler: async (ctx, { c }) => {
    await actionCases[c]!(ctx);
  },
});
export const actionCaught = actionGeneric({
  args: { c: v.string() },
  handler: async (ctx, { c }) => {
    try {
      await actionCases[c]!(ctx);
    } catch (e) {
      const err = e as Error;
      console.log(err);
      console.log(String(err.stack));
      return { name: err.name, message: err.message, stack: String(err.stack) };
    }
  },
});
