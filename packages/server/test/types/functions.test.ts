// The typed functions (STUDY-36): contexts bound to a data model, arguments and results from validators,
// and `ApiFromModules` / `FilterApi` turning modules into `api` and `internal` — checked by `tsc`. The
// runtime test checks Convex's markers and `returns` given as an object of validators.
import { expect, test } from "bun:test";
import { type DataModelFromSchemaDefinition, defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { anyApi, type FunctionReference } from "@bunvex/protocol";
import { type GenericId, v } from "@bunvex/values";
// From the package's index, as `_generated/` imports them.
import {
  type ActionBuilder,
  type ApiFromModules,
  actionGeneric,
  type FilterApi,
  Functions,
  filterApi,
  type GenericQueryCtx,
  internalMutationGeneric,
  type MutationBuilder,
  type MutationBuilderWithTable,
  mutationGeneric,
  type QueryBuilder,
  type QueryBuilderWithTable,
  queryGeneric,
} from "../../src/index.ts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const check = <T extends true>(_: T) => {};

const schema = defineSchema({
  messages: defineTable({ author: v.string(), body: v.string() }).index("by_author", ["author"]),
});
type DM = DataModelFromSchemaDefinition<typeof schema>;
// What `_generated/server` does: the generic builders, typed with the app's data model.
const query = queryGeneric as QueryBuilder<DM, "public">;
const mutation = mutationGeneric as MutationBuilder<DM, "public">;
const internalMutation = internalMutationGeneric as MutationBuilder<DM, "internal">;
const action = actionGeneric as ActionBuilder<DM, "public">;

// A module, as `typeof import("../messages")` would be.
const messages = {
  list: query({
    args: { author: v.string() },
    handler: async (ctx, { author }) => {
      check<Equal<typeof author, string>>(true);
      return ctx.db
        .query("messages")
        .withIndex("by_author", (q) => q.eq("author", author))
        .collect();
    },
  }),
  count: query(async (ctx) => (await ctx.db.query("messages").collect()).length),
  send: mutation({
    args: { author: v.string(), body: v.string() },
    returns: v.id("messages"),
    handler: (ctx, args) => ctx.db.insert("messages", args),
  }),
  clear: internalMutation({ args: {}, handler: async () => {} }),
  helper: (x: number) => x,
  constant: 3,
};
const nested = {
  run: action({
    args: { n: v.number() },
    handler: async (ctx, { n }): Promise<string> => {
      const count = await ctx.runQuery(api.messages.count);
      check<Equal<typeof count, number>>(true);
      const id = await ctx.runMutation(api.messages.send, { author: "a", body: String(n) });
      check<Equal<typeof id, GenericId<"messages">>>(true);
      // @ts-expect-error a missing argument
      await ctx.runMutation(api.messages.send, { author: "a" });
      // @ts-expect-error a query is not a mutation
      await ctx.runMutation(api.messages.count);
      await ctx.scheduler.runAfter(0, internal.messages.clear, {});
      // @ts-expect-error an argument it does not take
      await ctx.scheduler.runAfter(0, internal.messages.clear, { x: 1 });
      return String(count);
    },
  }),
};

type FullApi = ApiFromModules<{ messages: typeof messages; "dir/nested": typeof nested }>;
// biome-ignore lint/suspicious/noExplicitAny: as `_generated/api.d.ts`
type PublicApi = FilterApi<FullApi, FunctionReference<any, "public">>;
// biome-ignore lint/suspicious/noExplicitAny: as above
type InternalApi = FilterApi<FullApi, FunctionReference<any, "internal">>;
const api = anyApi as unknown as PublicApi;
const internal = anyApi as unknown as InternalApi;

check<Equal<keyof PublicApi["messages"], "list" | "count" | "send">>(true);
check<Equal<keyof InternalApi["messages"], "clear">>(true);
check<Equal<keyof InternalApi, "messages">>(true);
check<Equal<PublicApi["messages"]["send"]["_args"], { author: string; body: string }>>(true);
check<Equal<PublicApi["messages"]["send"]["_returnType"], GenericId<"messages">>>(true);
check<Equal<PublicApi["messages"]["clear" & keyof PublicApi["messages"]], never>>(true);
check<Equal<PublicApi["messages"]["list"]["_returnType"][number]["body"], string>>(true);
check<Equal<PublicApi["dir"]["nested"]["run"]["_type"], "action">>(true);
check<Equal<PublicApi["dir"]["nested"]["run"]["_returnType"], string>>(true);
// A void result is null to a client.
check<Equal<InternalApi["messages"]["clear"]["_returnType"], null>>(true);

// `filterApi`: the same object, narrowed by its type (Convex's server/api.ts).
const queries = filterApi<PublicApi, FunctionReference<"query">>(api);
check<Equal<keyof typeof queries, "messages">>(true);
check<Equal<keyof typeof queries.messages, "list" | "count">>(true);
// @ts-expect-error a mutation is filtered out
void queries.messages.send;
test("filterApi returns its argument", () => {
  expect(filterApi(api)).toBe(api);
  expect(filterApi<typeof internal, FunctionReference<"mutation">>(internal)).toBe(internal);
});

// Misuse the types refuse.
mutation({
  args: { body: v.string() },
  returns: v.null(),
  // @ts-expect-error the result does not match `returns`
  handler: async () => "x",
});
query({
  args: { n: v.number() },
  // @ts-expect-error not a table of the data model
  handler: (ctx) => ctx.db.query("nope").collect(),
});
// @ts-expect-error not an index of messages
query((ctx: GenericQueryCtx<DM>) => ctx.db.query("messages").withIndex("by_body").collect());

test("functions carry Convex's markers, and `returns` may be an object of validators", async () => {
  expect(messages.list).toMatchObject({ isBunvexFunction: true, isQuery: true, isPublic: true });
  expect(messages.clear).toMatchObject({ isMutation: true, isInternal: true });
  expect(nested.run).toMatchObject({ isAction: true, isPublic: true });
  expect("isPublic" in messages.clear).toBe(false);

  const engine = await new Engine(schema, await MemoryPersistence.open(null, { durable: false })).init();
  const fns = new Functions(engine).register("m", {
    good: queryGeneric({ args: {}, returns: { n: v.number() }, handler: () => ({ n: 1 }) }),
    bad: queryGeneric({ args: {}, returns: { n: v.number() }, handler: () => ({ n: "x" }) as never }),
  });
  expect(await fns.runQuery("m:good", {})).toEqual({ n: 1 });
  await expect(fns.runQuery("m:bad", {})).rejects.toThrow(/ReturnsValidationError/);
  await engine.close();
});

// The table-scoped API (STUDY-66 §2), with Convex's `…WithTable` builders.
const queryWithTable = queryGeneric as unknown as QueryBuilderWithTable<DM, "public">;
const mutationWithTable = mutationGeneric as unknown as MutationBuilderWithTable<DM, "public">;
export const scoped = {
  read: queryWithTable({
    args: { id: v.id("messages") },
    handler: async (ctx, { id }) => {
      const doc = await ctx.db.table("messages").get(id);
      check<
        Equal<typeof doc, { _id: GenericId<"messages">; _creationTime: number; author: string; body: string } | null>
      >(true);
      // @ts-expect-error: a reader has no insert
      ctx.db.table("messages").insert;
      return ctx.db
        .table("messages")
        .query()
        .withIndex("by_author", (q) => q.eq("author", "ada"))
        .collect();
    },
  }),
  write: mutationWithTable(async (ctx) => {
    const id = await ctx.db.table("messages").insert({ author: "ada", body: "hi" });
    check<Equal<typeof id, GenericId<"messages">>>(true);
    await ctx.db.table("messages").patch(id, { body: "edited" });
    // @ts-expect-error: not a table of the data model
    ctx.db.table("nope");
  }),
};
