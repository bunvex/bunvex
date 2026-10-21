// The app of test/sharded-counter.test.ts (STUDY-183): the sharded counter's functions called as an app calls them
// (`components.<mount>.public.*`, arguments passed as given, bad ones included), its client (`ShardedCounter`, a fresh
// instance or one kept in the module), and its trigger with the helpers' triggers. On bunvex the harness renames
// the packages: `@convex-dev/sharded-counter` to `@bunvex/sharded-counter`, `convex-helpers` to `@bunvex/helpers`.
// biome-ignore-all lint/suspicious/noExplicitAny: the calls are built from the test's arguments, typed loosely
import { ShardedCounter } from "@convex-dev/sharded-counter";
import { componentsGeneric, mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";
import { customCtx, customMutation } from "convex-helpers/server/customFunctions";
import { Triggers } from "convex-helpers/server/triggers";

const components = componentsGeneric() as any;
const mount = (name?: string) => components[name ?? "shardedCounter"].public;

/** A component function called with `args` as given: its result, or its error's message. */
export const call = mutationGeneric({
  args: { mount: v.optional(v.string()), fn: v.string(), args: v.any() },
  handler: async (ctx, { mount: m, fn, args }) => {
    const ref = mount(m)[fn];
    const isQuery = fn === "count" || fn === "estimateCount";
    try {
      return { ok: isQuery ? await ctx.runQuery(ref, args) : await ctx.runMutation(ref, args) };
    } catch (e) {
      return { error: (e as Error).message };
    }
  },
});

/** A component query, from a query (a cached read, as an app's page reads it). */
export const read = queryGeneric({
  args: { mount: v.optional(v.string()), fn: v.string(), args: v.any() },
  handler: async (ctx, { mount: m, fn, args }) => await ctx.runQuery(mount(m)[fn], args),
});

const kept = new ShardedCounter(components.shardedCounter, { shards: { sticky: 10 } });

/** The client's methods, one call each, in order, on a fresh instance with `options` (or the kept one): the results. */
export const client = mutationGeneric({
  args: { options: v.optional(v.any()), keep: v.optional(v.boolean()), ops: v.array(v.any()) },
  handler: async (ctx, { options, keep, ops }) => {
    const counter = keep ? kept : new ShardedCounter<string>(components.shardedCounter, options);
    const out: unknown[] = [];
    for (const { op, name, count, readFromShards, via } of ops) {
      const c: any = via === "for" ? counter.for(name) : counter;
      const pre = via === "for" ? [ctx] : [ctx, name];
      if (op === "add" || op === "subtract")
        out.push(await (count === undefined ? c[op](...pre) : c[op](...pre, count)));
      else if (op === "estimateCount")
        out.push(await (readFromShards === undefined ? c[op](...pre) : c[op](...pre, readFromShards)));
      else out.push(await c[op](...pre));
    }
    return out.map((x) => x ?? null);
  },
});

const triggers = new Triggers<any>();
triggers.register("users", new ShardedCounter(components.shardedCounter).trigger("users") as any);
const withTriggers = customMutation(mutationGeneric, customCtx(triggers.wrapDB));

/** Users inserted, renamed and deleted through the trigger: the counter `users` follows the table's size. */
export const users = withTriggers({
  args: { insert: v.number(), rename: v.number(), remove: v.number() },
  handler: async (ctx, { insert, rename, remove }) => {
    for (let i = 0; i < insert; i++) await ctx.db.insert("users", { name: `u${i}` });
    const all = await ctx.db.query("users").collect();
    for (const u of all.slice(0, rename)) await ctx.db.patch(u._id, { name: `${u.name}!` });
    for (const u of all.slice(0, remove)) await ctx.db.delete(u._id);
    return (await ctx.db.query("users").collect()).length;
  },
});
