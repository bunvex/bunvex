// The component's functions taking and returning its ids.
import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";

export const takesMessageId = queryGeneric({ args: { id: v.id("messages") }, handler: async () => "accepted" });
export const newNote = mutationGeneric({
  args: {},
  returns: v.id("notes"),
  handler: async (ctx) => ctx.db.insert("notes", { n: 1 }),
});
export const takesNoteId = queryGeneric({ args: { id: v.id("notes") }, handler: async () => "accepted" });
