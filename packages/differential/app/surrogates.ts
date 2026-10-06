// Strings with a lone surrogate along each path (STUDY-135), for the differential tests: each function
// returns what each case gave (its value or its caught message), so both backends' answers compare.
// Written from scratch for this harness.
import { makeFunctionReference } from "convex/server";
import { ConvexError, v } from "convex/values";
import { action, mutation, query } from "./_generated/server";

const echoQRef = makeFunctionReference<"query">("surrogates:echoQ");
const echoMRef = makeFunctionReference<"mutation">("surrogates:echoM");
const H = "\ud800";
const L = "\udc00";
/** A fixed time to schedule at, so the text's `ts` (seconds) has the same digits on both backends. */
const AT = Date.UTC(2027, 0, 1);

async function caught(f: () => Promise<unknown>) {
  try {
    return { ok: await f() };
  } catch (e) {
    return { caught: String((e as Error).message) };
  }
}

export const echoQ = query({ args: { s: v.any() }, handler: async (_c, { s }) => s });
export const echoM = mutation({ args: { s: v.any() }, handler: async (_c, { s }) => s });

/** Writes: each kind of lone surrogate, the bytes before it, and the methods' texts. */
export const writes = mutation({
  args: {},
  handler: async (ctx) => {
    const ins = (doc: Record<string, unknown>) => caught(() => ctx.db.insert("a", doc));
    const id = await ctx.db.insert("a", { k: "ok" });
    return {
      high: await ins({ k: H }),
      low: await ins({ k: L }),
      twoHigh: await ins({ k: H + H }),
      lowHigh: await ins({ k: L + H }),
      inside: await ins({ k: `a${H}b` }),
      nested: await ins({ x: 1, y: { z: [1, H] } }),
      sorted: await ins({ z: H, a: 1 }),
      twoBytesBefore: await ins({ k: `é${H}` }),
      fourBytesBefore: await ins({ k: `😀${L}` }),
      twoBytesAfter: await ins({ k: `${H}é` }),
      escapeAfter: await ins({ k: `${H}\n` }),
      pair: await ins({ k: "😀" }),
      patch: await caught(() => ctx.db.patch(id, { k: H })),
      patchUndefined: await caught(() => ctx.db.patch(id, { b: undefined, k: H })),
      replace: await caught(() => ctx.db.replace(id, { k: H })),
    };
  },
});

/** Queries: the source, the order, the bounds and the operators before the value. */
export const queries = query({
  args: {},
  handler: async (ctx) => ({
    index: await caught(() =>
      ctx.db
        .query("a")
        .withIndex("by_k", (q) => q.eq("k", H))
        .collect(),
    ),
    filter: await caught(() =>
      ctx.db
        .query("a")
        .filter((q) => q.eq(q.field("k"), H))
        .collect(),
    ),
    orderedFilter: await caught(() =>
      ctx.db
        .query("a")
        .order("desc")
        .filter((q) => q.eq(q.field("k"), H))
        .collect(),
    ),
    secondBound: await caught(() =>
      ctx.db
        .query("a")
        .withIndex("by_k_n", (q) => q.eq("k", "x").gt("n", H))
        .first(),
    ),
    take: await caught(() =>
      ctx.db
        .query("a")
        .withIndex("by_k", (q) => q.eq("k", L))
        .take(3),
    ),
    page: await caught(() =>
      ctx.db
        .query("a")
        .withIndex("by_k", (q) => q.eq("k", H))
        .paginate({ numItems: 1, cursor: null }),
    ),
  }),
});

/** Nested calls and the scheduler from a mutation. */
export const nested = mutation({
  args: {},
  handler: async (ctx) => ({
    query: await caught(() => ctx.runQuery(echoQRef, { s: H })),
    mutation: await caught(() => ctx.runMutation(echoMRef, { s: H })),
    scheduled: await caught(() => ctx.scheduler.runAt(AT, echoMRef, { s: H })),
  }),
});

/** An action's calls and its scheduler. */
export const fromAction = action({
  args: {},
  handler: async (ctx) => ({
    query: await caught(() => ctx.runQuery(echoQRef, { s: H })),
    mutation: await caught(() => ctx.runMutation(echoMRef, { s: H })),
  }),
});

export const ret = query({ args: {}, handler: async () => H });
export const retObject = mutation({ args: {}, handler: async () => ({ k: L }) });
export const retAction = action({ args: {}, handler: async () => H });
export const logs = mutation({
  args: {},
  handler: async () => {
    console.log(`log ${H} line`);
    return null;
  },
});
export const throwsMessage = mutation({
  args: {},
  handler: async () => {
    throw new Error(`boom ${H}`);
  },
});
// `throw new ConvexError(H)` (string data) is left out: Convex answers an InternalServerError, bunvex a
// function error with no data (STUDY-135 Q1, DV-431).
export const throwsDataObject = mutation({
  args: {},
  handler: async () => {
    throw new ConvexError({ k: H });
  },
});
