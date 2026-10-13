// The app of test/storage-ids.test.ts: each storage method given an id, its error caught and returned as
// `<name>: <message>`, or what it gave (null or a value).
import { actionGeneric, mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";

const outcome = async (run: () => Promise<unknown>) => {
  try {
    return (await run()) === null ? "null" : "value";
  } catch (e) {
    return `${(e as Error).name}: ${(e as Error).message}`;
  }
};
const args = { id: v.string(), op: v.string() };

export const insert = mutationGeneric({ args: {}, handler: async (ctx) => ctx.db.insert("items", {}) });

export const inQuery = queryGeneric({
  args,
  handler: async (ctx, { id, op }) =>
    outcome(() => (op === "getUrl" ? ctx.storage.getUrl(id as never) : ctx.storage.getMetadata(id as never))),
});

export const inMutation = mutationGeneric({
  args,
  handler: async (ctx, { id, op }) =>
    outcome(() =>
      op === "getUrl"
        ? ctx.storage.getUrl(id as never)
        : op === "delete"
          ? ctx.storage.delete(id as never)
          : ctx.storage.getMetadata(id as never),
    ),
});

export const inAction = actionGeneric({
  args,
  handler: async (ctx, { id, op }) =>
    outcome(() =>
      op === "getUrl"
        ? ctx.storage.getUrl(id as never)
        : op === "delete"
          ? ctx.storage.delete(id as never)
          : op === "get"
            ? ctx.storage.get(id as never)
            : ctx.storage.getMetadata(id as never),
    ),
});
