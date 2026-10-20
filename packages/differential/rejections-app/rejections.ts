// The app of test/unhandled-rejections.test.ts: queries, mutations and actions that leave a promise rejected with no
// handler — before and after an operation, in an operation they did not await, in a timer, with a value that is not
// an error, with an application error — and the cases where a handler comes in time.
import { actionGeneric, makeFunctionReference, mutationGeneric, queryGeneric } from "convex/server";
import { ConvexError, v } from "convex/values";

// biome-ignore lint/suspicious/noExplicitAny: the app's own cases, typed loosely
type Ctx = any;
const qRef = makeFunctionReference<"query">("rejections:q");
const mRef = makeFunctionReference<"mutation">("rejections:m");
const countRef = makeFunctionReference<"query">("rejections:count");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Cases a query and a mutation share. */
const shared: Record<string, (ctx: Ctx) => Promise<unknown>> = {
  rejected: async () => {
    Promise.reject(new Error("never handled"));
    return 1;
  },
  rejectedAfterOp: async (ctx) => {
    await ctx.db.query("items").first();
    Promise.reject(new Error("after an operation"));
    return 1;
  },
  rejectedBeforeOp: async (ctx) => {
    Promise.reject(new Error("before an operation"));
    await ctx.db.query("items").first();
    return 1;
  },
  handledInTime: async () => {
    const p = Promise.reject(new Error("handled"));
    await null;
    await null;
    p.catch(() => {});
    return 1;
  },
  handledAfterOp: async (ctx) => {
    const p = Promise.reject(new Error("handled too late"));
    await ctx.db.query("items").first();
    p.catch(() => {});
    return 1;
  },
  asyncHelper: async () => {
    const helper = async () => {
      await null;
      throw new Error("from a helper");
    };
    void helper();
    return 1;
  },
  plainValue: async () => {
    Promise.reject("a plain string");
    return 1;
  },
  numberValue: async () => {
    Promise.reject(42);
    return 1;
  },
  objectValue: async () => {
    Promise.reject({ a: 1 });
    return 1;
  },
  undefinedValue: async () => {
    Promise.reject(undefined);
    return 1;
  },
  typeError: async () => {
    Promise.reject(new TypeError("a type error"));
    return 1;
  },
  applicationError: async () => {
    Promise.reject(new ConvexError({ code: 1 }));
    return 1;
  },
  applicationErrorString: async () => {
    Promise.reject(new ConvexError("with a message"));
    return 1;
  },
  unawaitedOp: async (ctx) => {
    ctx.db.get("nope");
    return 1;
  },
  unawaitedNested: async (ctx) => {
    ctx.runQuery(qRef, { c: "throws" });
    return 1;
  },
  // Convex runs reads in a batch (`AsyncSyscallBatch`): the get's rejection and the query's answer come together.
  unawaitedOpHandledLater: async (ctx) => {
    const p = ctx.db.get("nope");
    await ctx.db.query("items").first();
    p.catch(() => {});
    return 1;
  },
  // A nested call is a batch of its own: its rejection is checked before the read's answer comes.
  nestedHandledAfterRead: async (ctx) => {
    const p = ctx.runQuery(qRef, { c: "throws" });
    await ctx.db.query("items").first();
    p.catch(() => {});
    return 1;
  },
  readHandledAfterNested: async (ctx) => {
    const p = ctx.db.get("nope");
    await ctx.runQuery(qRef, { c: "handledInTime" });
    p.catch(() => {});
    return 1;
  },
  nestedRejectionCaught: async (ctx) => {
    try {
      await ctx.runQuery(qRef, { c: "rejected" });
      return "not caught";
    } catch (e) {
      return `caught: ${(e as Error).message.split("\n")[0]}`;
    }
  },
  throws: async () => {
    throw new Error("thrown");
  },
  rejectedThenThrows: async () => {
    const p = Promise.reject(new Error("rejected first"));
    await null;
    p.catch(() => {});
    throw new Error("then thrown");
  },
};

export const q = queryGeneric({
  args: { c: v.string() },
  handler: (ctx, { c }) => shared[c]!(ctx),
});

export const count = queryGeneric({
  args: { tag: v.string() },
  handler: async (ctx, { tag }) => (await ctx.db.query("items").collect()).filter((d) => d.tag === tag).length,
});

const mutationCases: Record<string, (ctx: Ctx, tag: string) => Promise<unknown>> = {
  ...Object.fromEntries(Object.entries(shared).map(([k, f]) => [k, (ctx: Ctx) => f(ctx)])),
  writes: async (ctx, tag) => {
    await ctx.db.insert("items", { tag });
    return 1;
  },
  writesThenRejects: async (ctx, tag) => {
    await ctx.db.insert("items", { tag });
    Promise.reject(new Error("after a write"));
    return 1;
  },
  unawaitedWrite: async (ctx, tag) => {
    await ctx.db.insert("items", { tag });
    ctx.db.patch("nope", { x: 1 });
    return 1;
  },
  nestedMutationCaught: async (ctx, tag) => {
    try {
      await ctx.runMutation(mRef, { c: "writesThenRejects", tag });
      return "not caught";
    } catch (e) {
      return `caught: ${(e as Error).message.split("\n")[0]}`;
    }
  },
};

export const m = mutationGeneric({
  args: { c: v.string(), tag: v.optional(v.string()) },
  handler: (ctx, { c, tag }) => mutationCases[c]!(ctx, tag ?? ""),
});

const actionCases: Record<string, (ctx: Ctx, tag: string) => Promise<unknown>> = {
  rejected: shared.rejected!,
  plainValue: shared.plainValue!,
  applicationError: shared.applicationError!,
  handledInTime: shared.handledInTime!,
  rejectedBeforeOp: async (ctx) => {
    Promise.reject(new Error("before an operation"));
    await ctx.runQuery(qRef, { c: "handledInTime" });
    return 1;
  },
  rejectedAfterOp: async (ctx) => {
    await ctx.runQuery(qRef, { c: "handledInTime" });
    Promise.reject(new Error("after an operation"));
    return 1;
  },
  handledAfterOp: async (ctx) => {
    const p = Promise.reject(new Error("handled too late"));
    await ctx.runQuery(qRef, { c: "handledInTime" });
    p.catch(() => {});
    return 1;
  },
  beforeTimer: async () => {
    Promise.reject(new Error("before a timer"));
    await sleep(20);
    return 1;
  },
  inTimer: async () => {
    setTimeout(() => {
      Promise.reject(new Error("in a timer"));
    }, 0);
    await sleep(50);
    return 1;
  },
  timerAfterAnswer: async () => {
    setTimeout(() => {
      Promise.reject(new Error("after the answer"));
    }, 0);
    return 1;
  },
  stopsTheAction: async (ctx, tag) => {
    Promise.reject(new Error("stops it"));
    await sleep(20);
    await ctx.runMutation(mRef, { c: "writes", tag: `${tag}-never` });
    return 1;
  },
  unawaitedNested: async (ctx) => {
    ctx.runQuery(qRef, { c: "throws" });
    await sleep(100);
    return 1;
  },
  nestedQueryCaught: async (ctx) => {
    try {
      await ctx.runQuery(qRef, { c: "rejected" });
      return "not caught";
    } catch (e) {
      return `caught: ${(e as Error).message.split("\n")[0]}`;
    }
  },
  nestedMutationRolledBack: async (ctx, tag) => {
    try {
      await ctx.runMutation(mRef, { c: "writesThenRejects", tag });
    } catch {}
    return await ctx.runQuery(countRef, { tag });
  },
};

export const a = actionGeneric({
  args: { c: v.string(), tag: v.optional(v.string()) },
  handler: (ctx, { c, tag }) => actionCases[c]!(ctx, tag ?? ""),
});
