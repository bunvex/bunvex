// One million checkboxes (after atrakh/one-million-checkboxes, as the sharded counter's own example): their bits in
// 250 documents, and how many are checked in a counter of 100 shards, so that many clicks at once rarely conflict.
import { ShardedCounter } from "@bunvex/sharded-counter";
import { v } from "bunvex/values";
import { api, components } from "./_generated/api";
import { internalMutation, type MutationCtx, mutation, query } from "./_generated/server";
import { BOXES_PER_DOCUMENT, isChecked, NUM_DOCUMENTS, shiftBit } from "./boxes";

const checkboxCounter = new ShardedCounter(components.checkboxCounter, {
  shards: { checkboxes: 100 },
}).for("checkboxes");

/** How many boxes are checked. */
export const countCheckedBoxes = query({
  args: {},
  returns: v.number(),
  handler: async (ctx) => await checkboxCounter.count(ctx),
});

/** One document's boxes, as bytes (undefined until one of them is first checked). */
export const get = query({
  args: { documentIdx: v.number() },
  handler: async (ctx, { documentIdx }) => {
    if (documentIdx < 0 || documentIdx >= NUM_DOCUMENTS) throw new Error("documentIdx out of range");
    const doc = await ctx.db
      .query("checkboxes")
      .withIndex("idx", (q) => q.eq("idx", documentIdx))
      .order("asc")
      .first();
    return doc?.boxes;
  },
});

async function toggleBox(
  ctx: MutationCtx,
  { documentIdx, arrayIdx, checked }: { documentIdx: number; arrayIdx: number; checked: boolean },
) {
  if (documentIdx < 0 || documentIdx >= NUM_DOCUMENTS) throw new Error("documentIdx out of range");
  if (arrayIdx < 0 || arrayIdx >= BOXES_PER_DOCUMENT) throw new Error("arrayIdx out of range");
  const find = () =>
    ctx.db
      .query("checkboxes")
      .withIndex("idx", (q) => q.eq("idx", documentIdx))
      .first();
  let doc = await find();
  if (!doc) {
    await ctx.db.insert("checkboxes", { idx: documentIdx, boxes: new Uint8Array(BOXES_PER_DOCUMENT / 8).buffer });
    doc = await find();
  }
  if (!doc) throw new Error("Failed to create checkbox");
  const changed = shiftBit(new Uint8Array(doc.boxes), arrayIdx, checked);
  // A box already in that state writes nothing, so it conflicts with nothing.
  if (!changed) return;
  await ctx.db.patch("checkboxes", doc._id, { idx: doc.idx, boxes: changed.buffer as ArrayBuffer });
  if (checked) await checkboxCounter.inc(ctx);
  else await checkboxCounter.dec(ctx);
}

/** Check or uncheck one box, and count it. */
export const toggle = mutation({
  args: { documentIdx: v.number(), arrayIdx: v.number(), checked: v.boolean() },
  handler: toggleBox,
});

/** Flip a few boxes of the first two columns of documents already created, later and at random (a load test). */
export const toggleRandom = internalMutation({
  args: {},
  handler: async (ctx) => {
    for (let i = 0; i < 10; i++) {
      const documentIdx = Math.floor(Math.random() * NUM_DOCUMENTS);
      const arrayIdx = Math.floor(Math.random() * 2);
      const doc = await ctx.db
        .query("checkboxes")
        .withIndex("idx", (q) => q.eq("idx", documentIdx))
        .first();
      if (doc)
        await ctx.scheduler.runAfter(Math.random() * 100_000, api.checkboxes.toggle, {
          documentIdx,
          arrayIdx,
          checked: !isChecked(new Uint8Array(doc.boxes), arrayIdx),
        });
    }
  },
});
