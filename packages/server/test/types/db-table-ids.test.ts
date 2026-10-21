// `ctx.db`'s explicit-table overloads (`get`, `patch`, `replace`, `delete` with the table first) take only that
// table's ids, as Convex's `GenericId<NonUnion<TableName>>`: the table is not inferred from the id into a union of
// both. Checked by `tsc` (`bun run typecheck`).
import { expect, test } from "bun:test";
import { v } from "@bunvex/values";
import {
  type DataModelFromSchemaDefinition,
  defineSchema,
  defineTable,
  type MutationBuilder,
  mutationGeneric,
} from "../../src/index.ts";

const schema = defineSchema({
  users: defineTable({ name: v.string() }),
  posts: defineTable({ title: v.string() }),
});
type DM = DataModelFromSchemaDefinition<typeof schema>;
const mutation = mutationGeneric as MutationBuilder<DM, "public">;

export const explicitTables = mutation({
  args: { user: v.id("users"), post: v.id("posts") },
  handler: async (ctx, { user, post }) => {
    await ctx.db.get("users", user);
    await ctx.db.patch("users", user, { name: "Ada" });
    await ctx.db.replace("posts", post, { title: "t" });
    await ctx.db.delete("posts", post);
    // @ts-expect-error a post's id is not a user's
    await ctx.db.get("users", post);
    // @ts-expect-error a post's id is not a user's
    await ctx.db.patch("users", post, { name: "Ada" });
    // @ts-expect-error a user's id is not a post's
    await ctx.db.replace("posts", user, { title: "t" });
    // @ts-expect-error a user's id is not a post's
    await ctx.db.delete("posts", user);
  },
});

test("the explicit-table overloads are checked by the type checker", () => {
  expect(explicitTables).toBeDefined();
});
