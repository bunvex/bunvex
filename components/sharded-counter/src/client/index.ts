// The sharded counter's client (STUDY-183 §3.2): the class an app's functions use, with the API of Convex's
// `@convex-dev/sharded-counter` 0.2.3 (`src/client/index.ts`): `ShardedCounter`, its methods and their defaults,
// `for(name)`, `trigger(name)`, and the `Trigger` / `Change` types. It calls the component through
// `components.shardedCounter` (or the name the app mounted it under).
//
// An instance remembers, per counter, the shard its last `add` wrote, and sends it with its later `add`s, so one
// instance keeps writing to one shard of a counter. The instance lives in the app's module scope, which bunvex
// evaluates once per code version: the remembered shard lasts that long, where on Convex it lasts a request. That
// changes which shard a write lands on, never a count (S-3).
import type {
  DocumentByName,
  FunctionArgs,
  FunctionReference,
  FunctionReturnType,
  GenericActionCtx,
  GenericDataModel,
  GenericMutationCtx,
  GenericQueryCtx,
  TableNamesInDataModel,
} from "@bunvex/server";
import type { GenericId } from "@bunvex/values";
import type { ComponentApi } from "../component/_generated/component.ts";

/**
 * Counters by name, each spread over several documents (shards) so that many mutations can update it at once
 * without conflicting. A write goes to one shard; reading the count reads them all.
 *
 * - More shards: more updates at once.
 * - Fewer shards: a cheaper `count`.
 *
 * ```ts
 * const counter = new ShardedCounter(components.shardedCounter, { shards: { beans: 32 } });
 * await counter.add(ctx, "beans", 5);
 * const beans = await counter.count(ctx, "beans");
 * ```
 */
export class ShardedCounter<ShardsKey extends string> {
  /** The shard each counter's last `add` through this instance wrote. */
  private readonly lastShard: Record<string, number> = {};
  /** A counter's shards: per fixed key (`shards`), else `defaultShards`, else the component's default (16). */
  private readonly options: { shards?: Partial<Record<ShardsKey, number>>; defaultShards?: number };

  /**
   * @param component The component's functions: `components.shardedCounter`, or the name it was mounted under.
   * @param options.shards The shards of each fixed key.
   * @param options.defaultShards The shards of every other key (16 when not given).
   */
  constructor(
    private readonly component: ComponentApi,
    options?: { shards?: Partial<Record<ShardsKey, number>>; defaultShards?: number },
  ) {
    this.options = options ?? {};
  }

  /** The shards the caller set for `name`, or undefined for the component's default. */
  private shardsOf(name: ShardsKey): number | undefined {
    return this.options.shards?.[name] ?? this.options.defaultShards;
  }

  /**
   * Add `count` (1 by default) to the counter `name`; a negative `count` lowers it.
   */
  async add<Name extends ShardsKey>(ctx: MutationCtx | ActionCtx, name: Name, count = 1) {
    const shard = await calls(ctx).runMutation(this.component.public.add, {
      name,
      count,
      shard: this.lastShard[name],
      shards: this.shardsOf(name),
    });
    this.lastShard[name] = shard;
  }

  /** Take `count` (1 by default) from the counter `name`. */
  async subtract<Name extends ShardsKey>(ctx: MutationCtx | ActionCtx, name: Name, count = 1) {
    return this.add(ctx, name, -count);
  }

  /** Add 1 to the counter `name`. */
  async inc<Name extends ShardsKey>(ctx: MutationCtx | ActionCtx, name: Name) {
    return this.add(ctx, name, 1);
  }

  /** Take 1 from the counter `name`. */
  async dec<Name extends ShardsKey>(ctx: MutationCtx | ActionCtx, name: Name) {
    return this.add(ctx, name, -1);
  }

  /**
   * The counter `name`: the sum of all its shards. In a mutation, this read conflicts with every write to the
   * counter.
   */
  async count<Name extends ShardsKey>(ctx: QueryCtx | MutationCtx | ActionCtx, name: Name) {
    return calls(ctx).runQuery(this.component.public.count, { name });
  }

  /**
   * Spread the counter `name` evenly over its shards: each gets an equal (unrounded) share of the total, and the
   * shards past its current number are removed. It reads and writes every shard, so it conflicts with every
   * update of the counter.
   */
  async rebalance<Name extends ShardsKey>(ctx: MutationCtx | ActionCtx, name: Name) {
    await calls(ctx).runMutation(this.component.public.rebalance, { name, shards: this.shardsOf(name) });
  }

  /** Remove the counter `name`: it counts 0 again. */
  async reset<Name extends ShardsKey>(ctx: MutationCtx | ActionCtx, name: Name) {
    await calls(ctx).runMutation(this.component.public.reset, { name });
  }

  /**
   * An estimate of the counter `name` from `readFromShards` shards (1 by default) picked at random, scaled to all
   * of them. It conflicts with fewer writes than `count`; it is close when the counts are spread evenly (after a
   * `rebalance`, or after many random writes), and rough otherwise.
   */
  async estimateCount<Name extends ShardsKey>(ctx: QueryCtx | MutationCtx | ActionCtx, name: Name, readFromShards = 1) {
    return await calls(ctx).runQuery(this.component.public.estimateCount, {
      name,
      shards: this.shardsOf(name),
      readFromShards,
    });
  }

  /**
   * The methods of one counter, `name` given once:
   *
   * ```ts
   * const users = new ShardedCounter(components.shardedCounter).for("users");
   * export const signUp = mutation({ handler: async (ctx) => users.inc(ctx) });
   * ```
   */
  for<Name extends ShardsKey>(name: Name) {
    return {
      /** Add `count` (1 by default). */
      add: async (ctx: MutationCtx | ActionCtx, count = 1) => this.add(ctx, name, count),
      /** Take `count` (1 by default). */
      subtract: async (ctx: MutationCtx | ActionCtx, count = 1) => this.add(ctx, name, -count),
      /** Add 1. */
      inc: async (ctx: MutationCtx | ActionCtx) => this.add(ctx, name, 1),
      /** Take 1. */
      dec: async (ctx: MutationCtx | ActionCtx) => this.add(ctx, name, -1),
      /** The count, from every shard (in a mutation, it conflicts with every write to the counter). */
      count: async (ctx: QueryCtx | MutationCtx | ActionCtx) => this.count(ctx, name),
      /** Remove the counter. */
      reset: async (ctx: MutationCtx | ActionCtx) => this.reset(ctx, name),
      /** Spread the count evenly over the shards. */
      rebalance: async (ctx: MutationCtx | ActionCtx) => this.rebalance(ctx, name),
      /** An estimate from `readFromShards` random shards (1 by default). */
      estimateCount: async (ctx: QueryCtx | MutationCtx | ActionCtx, readFromShards = 1) =>
        this.estimateCount(ctx, name, readFromShards),
    };
  }

  /**
   * A trigger (`@bunvex/helpers/server/triggers`) that keeps the counter `name` equal to a table's size: 1 more on
   * each insert, 1 less on each delete, nothing on an update.
   *
   * ```ts
   * triggers.register("users", counter.trigger("users"));
   * ```
   */
  trigger<Ctx extends MutationCtx, Name extends ShardsKey>(
    name: Name,
  ): Trigger<Ctx, GenericDataModel, TableNamesInDataModel<GenericDataModel>> {
    return async (ctx, change) => {
      if (change.operation === "insert") await this.inc(ctx, name);
      else if (change.operation === "delete") await this.dec(ctx, name);
    };
  }
}

/** A function run with the change when a document of `TableName` changes, as `@bunvex/helpers`' triggers call it. */
export type Trigger<Ctx, DataModel extends GenericDataModel, TableName extends TableNamesInDataModel<DataModel>> = (
  ctx: Ctx,
  change: Change<DataModel, TableName>,
) => Promise<void>;

/** One document's change: its id, the operation, and the document before (`oldDoc`) and after (`newDoc`). */
export type Change<DataModel extends GenericDataModel, TableName extends TableNamesInDataModel<DataModel>> = {
  id: GenericId<TableName>;
} & (
  | { operation: "insert"; oldDoc: null; newDoc: DocumentByName<DataModel, TableName> }
  | {
      operation: "update";
      oldDoc: DocumentByName<DataModel, TableName>;
      newDoc: DocumentByName<DataModel, TableName>;
    }
  | { operation: "delete"; oldDoc: DocumentByName<DataModel, TableName>; newDoc: null }
);

/** The calls the client makes on a context, by reference: one signature each. */
type Calls = {
  runQuery<Q extends FunctionReference<"query", "internal">>(
    query: Q,
    args: FunctionArgs<Q>,
  ): Promise<FunctionReturnType<Q>>;
  runMutation<M extends FunctionReference<"mutation", "internal">>(
    mutation: M,
    args: FunctionArgs<M>,
  ): Promise<FunctionReturnType<M>>;
};
/**
 * A context as the calls the client makes on it. Each of bunvex's contexts also takes a function by its name (an
 * overload of `runQuery` and `runMutation`), and TypeScript cannot call a method through a union of overloaded
 * types (`MutationCtx | ActionCtx`); every context has these signatures.
 */
const calls = (ctx: QueryCtx | MutationCtx | ActionCtx) => ctx as unknown as Calls;

type QueryCtx = Pick<GenericQueryCtx<GenericDataModel>, "runQuery">;
type MutationCtx = Pick<GenericMutationCtx<GenericDataModel>, "runQuery" | "runMutation">;
type ActionCtx = Pick<GenericActionCtx<GenericDataModel>, "runQuery" | "runMutation" | "runAction">;
