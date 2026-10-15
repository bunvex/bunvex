// Documents for the index list test, so each index has something to hold.
import { mutationGeneric } from "convex/server";
import { v } from "convex/values";

export const add = mutationGeneric({
  args: { n: v.number() },
  handler: async ({ db }, { n }) => {
    for (let i = 0; i < n; i++)
      await db.insert("docs", {
        body: `doc ${i}`,
        title: `title ${i}`,
        author: i % 2 ? "ana" : "bo",
        n: i,
        e: [i, 1, 0],
        f: [1, i],
      });
  },
});
