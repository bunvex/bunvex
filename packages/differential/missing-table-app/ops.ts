// An id whose table does not exist in each database call that takes one (STUDY-187 §2.9): what each answers.
import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";

const attempt = async (f: () => Promise<unknown>) => {
  try {
    return { value: (await f()) ?? null };
  } catch (e) {
    return { error: (e as Error).message };
  }
};

export const writes = mutationGeneric({
  args: { id: v.string() },
  handler: async ({ db }, { id }) => ({
    get: await attempt(() => db.get(id as never)),
    delete: await attempt(() => db.delete(id as never)),
    patch: await attempt(() => db.patch(id as never, { x: 1 } as never)),
    replace: await attempt(() => db.replace(id as never, { x: 1 } as never)),
    normalizeId: db.normalizeId("t" as never, id),
  }),
});

export const read = queryGeneric({
  args: { id: v.string() },
  handler: async ({ db }, { id }) => attempt(() => db.get(id as never)),
});

export const seed = mutationGeneric({ args: {}, handler: async ({ db }) => db.insert("t" as never, {} as never) });
