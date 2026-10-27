// Checking a limit across its shards (STUDY-197 §1.3), as Convex's package does:
//
// - the request is first checked against what any shard could ever hold, and refused with an error if it never fits;
// - each shard holds `rate / shards` (and `capacity`, `maxReserved` likewise); two distinct shards are picked at
//   random, the first one read, and the second only when the first has a row and there are 3 shards or more;
// - one shard that fits wins (the fuller one if both do); if neither fits alone, the two are pooled, each brought to
//   the same value;
// - `throws` turns a `retryAfter` into `BunvexError({kind: "RateLimited", name, retryAfter})` (Convex's
//   `ConvexError`, DV-538).
import { BunvexError, type Infer } from "@bunvex/values";
import {
  calculateRateLimit,
  type configValidator,
  type RateLimitArgs,
  type RateLimitError,
  type RateLimitReturns,
} from "../shared";
import type { Doc } from "./_generated/dataModel";
import type { DatabaseReader } from "./_generated/server";

type Config = Infer<typeof configValidator>;

/** Below this many shards, reading a second one would read (and depend on) every shard anyway. */
export const MIN_CHOOSE_TWO = 3;

/** Two distinct shards, each uniformly at random. */
export function getTwoRandomShards(shards: number): [number, number] {
  const one = Math.floor(Math.random() * shards);
  const two = (one + 1 + Math.floor(Math.random() * (shards - 1))) % shards;
  return [one, two];
}

export async function checkRateLimitOrThrow(db: DatabaseReader, args: RateLimitArgs) {
  const result = await checkRateLimitSharded(db, args);
  if (result.status.retryAfter && args.throws) {
    throw new BunvexError({
      kind: "RateLimited",
      name: args.name,
      retryAfter: result.status.retryAfter,
    } satisfies RateLimitError);
  }
  return result;
}

type ShardUpdate = { existing: Doc<"rateLimits"> | null; value: number; ts: number; shard: number };

async function checkRateLimitSharded(
  db: DatabaseReader,
  args: RateLimitArgs,
): Promise<{ status: RateLimitReturns; updates: ShardUpdate[] }> {
  validateRequest(args);
  const unsharded = configWithDefaults(args.config);
  const { shards } = unsharded;
  const config = shardConfig(unsharded, shards);
  const shardArgs = { ...args, config };
  const [first, second] = getTwoRandomShards(shards);
  const one = await checkShard(db, shardArgs, first);
  if (!one.existing || shards < MIN_CHOOSE_TWO) return single(one);
  const two = await checkShard(db, shardArgs, second);
  if (one.status.ok && !two.status.ok) return single(one);
  if (!one.status.ok && two.status.ok) return single(two);
  if (one.status.ok && two.status.ok) return single(one.value > two.value ? one : two);
  if (one.status.ok || two.status.ok) throw new Error("Unreachable");

  // Neither fits alone: pool them. Each value already had `count` taken, so add it back once for the balance, and
  // bring both to the same value.
  const count = args.count ?? 1;
  const balance = one.value + two.value + count;
  const oneShared = _checkRateLimitInternal(one.existing, config, one.value + count - balance / 2, args.reserve);
  const twoShared = _checkRateLimitInternal(two.existing, config, two.value + count - balance / 2, args.reserve);
  if (!oneShared.status.ok && !twoShared.status.ok) {
    // Not even together: wait until both could.
    return {
      status: { ok: false, retryAfter: Math.max(oneShared.status.retryAfter, twoShared.status.retryAfter) } as const,
      updates: [],
    };
  }
  // One fitting and not the other is rare (float rounding); then neither is written.
  const ok = oneShared.status.ok && twoShared.status.ok;
  const updates: ShardUpdate[] = ok
    ? [
        { value: oneShared.value, ts: oneShared.ts, existing: one.existing, shard: one.shard },
        { value: twoShared.value, ts: twoShared.ts, existing: two.existing, shard: two.shard },
      ]
    : [];
  if (!oneShared.status.retryAfter && !twoShared.status.retryAfter) {
    return { status: { ok: true, retryAfter: undefined }, updates };
  }
  const retryAfter = Math.max(oneShared.status.retryAfter ?? 0, twoShared.status.retryAfter ?? 0);
  return { status: { ok, retryAfter } as RateLimitReturns, updates };
}

/** The config with `shards` rounded (1 by default) and `capacity` defaulting to `rate`. */
export function configWithDefaults(config: Config) {
  return {
    ...config,
    shards: Math.round(config.shards || 1),
    capacity: config.capacity ?? config.rate,
  };
}

/** Refuse a request no shard could ever satisfy. */
function validateRequest(args: RateLimitArgs) {
  const { shards, capacity, maxReserved } = configWithDefaults(args.config);
  if (shards <= 0) throw new Error("Shards must be a positive number");
  const shardFactor = shards < MIN_CHOOSE_TWO ? 1 : shards / 2;
  const max = capacity / shardFactor;
  const count = args.count ?? 1;
  const perShards = shards > 1 ? ` per ${shards} shards.` : ".";
  if (args.reserve) {
    if (maxReserved) {
      const most = max + maxReserved / shardFactor;
      if (count > most)
        throw new Error(`Rate limit ${args.name} count ${count} exceeds ${most.toFixed(2)}${perShards}`);
    }
  } else if (count > max) {
    throw new Error(`Rate limit ${args.name} count ${count} exceeds ${max}${perShards}`);
  }
}

function single(result: Awaited<ReturnType<typeof checkShard>>) {
  const { status, ...update } = result;
  return { status, updates: status.ok ? [update] : [] };
}

async function checkShard(db: DatabaseReader, args: RateLimitArgs, shard: number) {
  const existing = await getShard(db, args.name, args.key, shard);
  return { ..._checkRateLimitInternal(existing, args.config, args.count, args.reserve), shard, existing };
}

export function getShard(db: DatabaseReader, name: string, key: string | undefined, shard: number) {
  return db
    .query("rateLimits")
    .withIndex("name", (q) => q.eq("name", name).eq("key", key).eq("shard", shard))
    .unique();
}

/** One shard's share of the config. */
function shardConfig(config: Config, shards: number): Config {
  if (shards === 1) return config;
  const sharded = { ...config };
  sharded.rate /= shards;
  if (sharded.capacity) sharded.capacity /= shards;
  if (sharded.maxReserved) sharded.maxReserved /= shards;
  return sharded;
}

/** One state checked at now: refused when negative, unless reserving within `maxReserved`. Exported for tests. */
export function _checkRateLimitInternal(
  existing: { value: number; ts: number } | null,
  config: Config,
  count = 1,
  reserve = false,
) {
  const { value, ts, retryAfter } = calculateRateLimit(existing, config, Date.now(), count);
  if (value < 0 && (!reserve || (config.maxReserved && -value > config.maxReserved))) {
    return { status: { ok: false, retryAfter: retryAfter! } as const, value, ts };
  }
  return { status: { ok: true, retryAfter } as const, value, ts };
}
