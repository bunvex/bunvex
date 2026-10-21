// convex-helpers' `server/stream.flatmap.test.ts` (e48f9df) ported to bunvex (STUDY-181 PR 3): resuming a flatMap
// under a row or byte budget past empty and filtered outer items, nested and merged; the bytes of a suppressed
// placeholder carried to the next item; and adjacent pages staying contiguous after inserts. On the app of
// fixtures/stream (its `groups` and `rows`), the stream functions inline in `t.run`, as upstream's.
// biome-ignore-all lint/suspicious/noExplicitAny: inline functions get `ctx` untyped, as upstream's tests use it
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { bunvexTest, type TestBunvex } from "@bunvex/testing";
import { type GenericId, getDocumentSize } from "@bunvex/values";
import { mergedStream, stream } from "../../src/server/stream.ts";
import schema from "../fixtures/stream/bunvex/schema.ts";

const APP = join(import.meta.dir, "..", "fixtures", "stream");
const open: TestBunvex[] = [];
afterEach(async () => {
  for (const t of open.splice(0)) await t.close();
});
const setup = () => {
  const t = bunvexTest({ cwd: APP });
  open.push(t);
  return t;
};

const innerFields = ["groupId", "position", "_creationTime", "_id"];

describe.each(["asc", "desc"] as const)("flatMap resume (%s)", (order) => {
  test.each([{ maximumRowsRead: 1 }, { maximumBytesRead: 1 }])(
    "budgeted walks advance past empty and filtered items: %j",
    async (limit) => {
      const t = setup();
      await t.run(async (ctx: any) => {
        const groupIds: GenericId<"groups">[] = [];
        for (let position = 0; position < 3; position++) groupIds.push(await ctx.db.insert("groups", { position }));
        const rowIds: string[] = [];
        for (let position = 0; position < 3; position++)
          rowIds.push(await ctx.db.insert("rows", { groupId: groupIds[1]!, position }));
        const expected = order === "asc" ? rowIds : rowIds.toReversed();
        const db = stream(ctx.db, schema);
        const outer = db.query("groups").withIndex("position").order(order);
        const inner = (groupId: GenericId<"groups">) =>
          db
            .query("rows")
            .withIndex("group_position", (q) => q.eq("groupId", groupId))
            .order(order);
        const flat = outer.flatMap(async (group) => inner(group._id), innerFields);
        const empty = outer.flatMap(
          async (group) =>
            db
              .query("rows")
              .withIndex("group_position", (q) => q.eq("groupId", group._id).gt("position", 10))
              .order(order),
          innerFields,
        );
        for (const [name, query] of [
          ["empty", flat],
          [
            "filtered",
            outer
              .filterWith(async (group) => group.position === 1)
              .flatMap(async (group) => inner(group._id), innerFields),
          ],
          [
            "nested",
            outer.flatMap(
              async (group) =>
                inner(group._id).flatMap(
                  async (row) =>
                    db
                      .query("rows")
                      .withIndex("group_position", (q) => q.eq("groupId", row.groupId).eq("position", row.position))
                      .order(order),
                  innerFields,
                ),
              [...innerFields, ...innerFields],
            ),
          ],
          // Both share the outer keys: a placeholder of the empty one must not skip the other's unread inner rows.
          ["merged", mergedStream([empty, flat], flat.getIndexFields())],
        ] as const) {
          const actual: string[] = [];
          const cursors = new Set<string>();
          let cursor: string | null = null;
          let done = false;
          for (let pageNumber = 0; pageNumber < 20; pageNumber++) {
            const page = await query.paginate({ cursor, numItems: 1, ...limit });
            actual.push(...page.page.map((row) => row._id));
            if (page.isDone) {
              done = true;
              break;
            }
            expect({ name, repeated: cursors.has(page.continueCursor) }).toEqual({ name, repeated: false });
            cursors.add(page.continueCursor);
            cursor = page.continueCursor;
          }
          expect({ name, done, actual }).toEqual({ name, done: true, actual: expected });
        }
      });
    },
  );

  test("suppressed placeholders carry their bandwidth to the next result", async () => {
    const t = setup();
    await t.run(async (ctx: any) => {
      const firstId = await ctx.db.insert("groups", { position: order === "asc" ? 0 : 2 });
      const secondId = await ctx.db.insert("groups", { position: 1 });
      const rowId = await ctx.db.insert("rows", { groupId: secondId, position: 0 });
      const db = stream(ctx.db, schema);
      const query = db
        .query("groups")
        .withIndex("position")
        .order(order)
        .flatMap(
          async (group) =>
            db
              .query("rows")
              .withIndex("group_position", (q) => q.eq("groupId", group._id))
              .order(order),
          innerFields,
        );
      const first = await query.paginate({ cursor: null, numItems: 1, maximumRowsRead: 1 });
      expect(first.page).toEqual([]);
      const key = JSON.parse(first.continueCursor);
      const narrowed = query.narrow({
        lowerBound: order === "asc" ? key : [],
        lowerBoundInclusive: order !== "asc",
        upperBound: order === "desc" ? key : [],
        upperBoundInclusive: order !== "desc",
      });
      const item = await narrowed.iterWithKeys(true)[Symbol.asyncIterator]().next();
      expect(item.value?.[0]?._id).toBe(rowId);
      const firstGroup = await ctx.db.get("groups", firstId);
      const secondGroup = await ctx.db.get("groups", secondId);
      const row = await ctx.db.get("rows", rowId);
      expect(item.value?.[2]).toBe(getDocumentSize(firstGroup) + getDocumentSize(secondGroup) + getDocumentSize(row));
    });
  });

  test("placeholder endpoints keep adjacent pages contiguous after inserts", async () => {
    const t = setup();
    await t.run(async (ctx: any) => {
      const firstId = await ctx.db.insert("groups", { position: 0 });
      const db = stream(ctx.db, schema);
      const query = db
        .query("groups")
        .withIndex("position", (q) => q.gte("position", -1).lte("position", 1))
        .order(order)
        .flatMap(
          async (group) =>
            db
              .query("rows")
              .withIndex("group_position", (q) => q.eq("groupId", group._id).gte("position", 0))
              .order(order),
          innerFields,
        );
      const first = await query.paginate({ cursor: null, numItems: 1, maximumRowsRead: 1 });
      expect(first.page).toEqual([]);
      const inserted = await ctx.db.insert("rows", { groupId: firstId, position: 1 });
      await ctx.db.insert("rows", { groupId: firstId, position: -1 });
      const nextId = await ctx.db.insert("groups", { position: order === "asc" ? 1 : -1 });
      const later = await ctx.db.insert("rows", { groupId: nextId, position: 1 });
      const foreignId = await ctx.db.insert("groups", { position: 99 });
      await ctx.db.insert("rows", { groupId: foreignId, position: 1 });
      const resumed = await query.paginate({ cursor: first.continueCursor, numItems: 10 });
      const refreshed = await query.paginate({ cursor: null, endCursor: first.continueCursor, numItems: 10 });
      expect(refreshed.page.map((row) => row._id)).toEqual(order === "asc" ? [] : [inserted]);
      expect(resumed.page.map((row) => row._id)).toEqual(order === "asc" ? [inserted, later] : [later]);
    });
  });
});
