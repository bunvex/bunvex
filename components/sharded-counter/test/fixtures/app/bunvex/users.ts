// The app's use of the counter: `trigger("users")` registered with `@bunvex/helpers`' triggers keeps the count of
// `users` (upstream's example `insertUserWithTrigger`), and the client's methods called from the app's functions.
import { customCtx, customMutation } from "@bunvex/helpers/server/customFunctions";
import { Triggers } from "@bunvex/helpers/server/triggers";
import {
  componentsGeneric,
  type DataModelFromSchemaDefinition,
  type MutationBuilder,
  mutationGeneric,
  type QueryBuilder,
  queryGeneric,
} from "@bunvex/server";
import { ShardedCounter } from "@bunvex/sharded-counter";
import type { ComponentApi } from "@bunvex/sharded-counter/_generated/component.js";
import { v } from "@bunvex/values";
import type schema from "./schema.ts";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
const mutation = mutationGeneric as MutationBuilder<DataModel, "public">;
const query = queryGeneric as QueryBuilder<DataModel, "public">;
const components = componentsGeneric() as unknown as { shardedCounter: ComponentApi; otherCounter: ComponentApi };

const counter = new ShardedCounter(components.shardedCounter, { shards: { users: 3 } });
const other = new ShardedCounter(components.otherCounter);

const triggers = new Triggers<DataModel>();
triggers.register("users", counter.trigger("users"));
const mutationWithTriggers = customMutation(mutation, customCtx(triggers.wrapDB));

export const insert = mutationWithTriggers({
  args: { name: v.string() },
  handler: async (ctx, { name }) => ctx.db.insert("users", { name }),
});

export const rename = mutationWithTriggers({
  args: { id: v.id("users"), name: v.string() },
  handler: async (ctx, { id, name }) => {
    await ctx.db.patch(id, { name });
  },
});

export const remove = mutationWithTriggers({
  args: { id: v.id("users") },
  handler: async (ctx, { id }) => {
    await ctx.db.delete(id);
  },
});

export const userCount = query({ args: {}, handler: async (ctx) => counter.count(ctx, "users") });

/** A user inserted without the trigger: the counter does not see it. */
export const insertRaw = mutation({
  args: { name: v.string() },
  handler: async (ctx, { name }) => ctx.db.insert("users", { name }),
});

/** The same key in the other mount: a counter of its own. */
export const bumpOther = mutation({ args: {}, handler: async (ctx) => other.inc(ctx, "users") });
export const otherCount = query({ args: {}, handler: async (ctx) => other.count(ctx, "users") });
