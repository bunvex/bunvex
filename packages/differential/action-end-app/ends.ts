// What an action leaves behind when it answers (STUDY-171 §12.11, owner 2026-10-21): a timer still pending, an
// interval, an operation's continuation. Convex ends the isolate with the action (environment/action/mod.rs), so none
// of them runs; `rows` counts what they wrote, `ticks` what an interval wrote while the action still ran.
import { actionGeneric, makeFunctionReference, mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";

const insRef = makeFunctionReference<"mutation">("ends:ins");
const rowsRef = makeFunctionReference<"query">("ends:rows");

export const ins = mutationGeneric({
  args: { tag: v.string() },
  handler: async (ctx, { tag }) => ctx.db.insert("items", { tag }),
});

export const rows = queryGeneric({
  args: { tag: v.string(), nonce: v.number() },
  handler: async (ctx, { tag }) => (await ctx.db.query("items").collect()).filter((d) => d.tag === tag).length,
});

/** A timer set while the action runs and fired before it answers: it works. */
export const timerBefore = actionGeneric({
  args: { tag: v.string() },
  handler: async (ctx, { tag }) => {
    await new Promise<void>((r) =>
      setTimeout(async () => {
        await ctx.runMutation(insRef, { tag });
        r();
      }, 20),
    );
    return await ctx.runQuery(rowsRef, { tag, nonce: Math.random() });
  },
});

/** A timer still pending when the action answers. */
export const timerAfter = actionGeneric({
  args: { tag: v.string() },
  handler: async (ctx, { tag }) => {
    setTimeout(() => void ctx.runMutation(insRef, { tag }).catch(() => {}), 100);
    return 1;
  },
});

/** An interval that writes while the action runs, and is left running when it answers. */
export const interval = actionGeneric({
  args: { tag: v.string() },
  handler: async (ctx, { tag }) => {
    setInterval(() => void ctx.runMutation(insRef, { tag }).catch(() => {}), 40);
    await new Promise((r) => setTimeout(r, 150));
    return 1;
  },
});

/** An operation's continuation, after the action answered. */
export const continuation = actionGeneric({
  args: { tag: v.string() },
  handler: async (ctx, { tag }) => {
    void ctx
      .runQuery(rowsRef, { tag, nonce: Math.random() })
      .then(() => new Promise((r) => setTimeout(r, 50)))
      .then(() => ctx.runMutation(insRef, { tag }))
      .catch(() => {});
    return 1;
  },
});
