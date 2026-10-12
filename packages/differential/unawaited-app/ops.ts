// The unawaited-operations warning (STUDY-143): actions that start operations and return (or time out) without
// awaiting them, named so the test picks which ones; `awaited` awaits every one of them.
import { actionGeneric, createFunctionHandle, makeFunctionReference, queryGeneric } from "convex/server";
import { v } from "convex/values";

const qRef = makeFunctionReference<"query">("ops:q");
const slowRef = makeFunctionReference<"action">("ops:slow");

export const q = queryGeneric({ args: {}, handler: async () => 1 });

export const slow = actionGeneric({
  args: { ms: v.number() },
  handler: async (_ctx, { ms }) => {
    await new Promise((r) => setTimeout(r, ms));
    return 1;
  },
});

// biome-ignore lint/suspicious/noExplicitAny: `ctx.meta` is not in every version's types
type Ctx = any;

const operations = (ctx: Ctx, url: string): Record<string, () => Promise<unknown>> => ({
  fetch: () => fetch(url),
  query: () => ctx.runQuery(qRef, {}),
  action: () => ctx.runAction(slowRef, { ms: 300 }),
  schedule: () => ctx.scheduler.runAfter(1000, qRef, {}),
  getUrl: () => ctx.storage.getUrl("kg2bsnsx9xvhqkvsfs0mv9t3s97g1h9k"),
  generateUploadUrl: () => ctx.storage.generateUploadUrl(),
  getUserIdentity: () => ctx.auth.getUserIdentity(),
  functionMetadata: () => ctx.meta.getFunctionMetadata(),
  deploymentMetadata: () => ctx.meta.getDeploymentMetadata(),
  requestMetadata: () => ctx.meta.getRequestMetadata(),
  handle: () => createFunctionHandle(qRef),
  store: () => ctx.storage.store(new Blob(["x"])),
  timer: () => new Promise((r) => setTimeout(r, 2000)),
});

export const leave = actionGeneric({
  args: { url: v.string(), which: v.array(v.string()) },
  handler: async (ctx, { url, which }) => {
    const all = operations(ctx, url);
    for (const w of which) void all[w]!().catch(() => {});
    return null;
  },
});

export const awaited = actionGeneric({
  args: { url: v.string(), which: v.array(v.string()) },
  handler: async (ctx, { url, which }) => {
    const all = operations(ctx, url);
    await Promise.allSettled(which.map((w) => all[w]!()));
    return null;
  },
});

// Left unawaited, but answered while the action waits on a timer.
export const later = actionGeneric({
  args: {},
  handler: async (ctx) => {
    void ctx.runQuery(qRef, {}).catch(() => {});
    void ctx.auth.getUserIdentity().catch(() => {});
    await new Promise((r) => setTimeout(r, 200));
    return null;
  },
});

export const hang = actionGeneric({
  args: { url: v.string() },
  handler: async (ctx, { url }) => {
    void fetch(url).catch(() => {});
    void ctx.runAction(slowRef, { ms: 300 }).catch(() => {});
    await new Promise(() => {});
  },
});
