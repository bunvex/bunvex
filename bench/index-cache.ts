// STUDY-136: what an index cache (a cache of persistence index reads, under the query cache) gains, in
// process. A chat-like app: channels with messages (by_channel), users, one settings document.
// - query  (per user): reads its user, the settings and the newest 20 messages of a channel. Its query-cache
//   key carries the user (as a query reading ctx.auth does), so users do not share results.
// - mutation (send): reads its user, the settings and the channel, then inserts a message into it, which
//   invalidates that channel's range in both caches.
// Channels and users are drawn with a Zipf-like skew. Phases alternate the index cache off / on, each with
// fresh caches; the persistence calls are counted under the engine.
//   PERSISTENCE=memory|sqlite|postgres bun bench/index-cache.ts
//   Env: PG_URL (postgres), DO_NOT_REQUIRE_SSL, CHANNELS (1000), MSGS (50 per channel), USERS (10000),
//        WRITE_PCT (10), CONC (32 concurrent clients), SECS (10 per phase), ROUNDS (2), SKEW (1.0),
//        INDEX_CACHE_MB (64), SCENARIO (mixed | queries | unique: every query a distinct cache key, the query cache never hits)
import { defineSchema, defineTable, Engine, IndexCache, type Persistence } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { SqlitePersistence } from "@bunvex/core/persistence/sqlite";
import { v } from "@bunvex/values";

const env = (k: string, d: number) => Number(process.env[k] ?? d);
const KIND = process.env.PERSISTENCE ?? "memory";
const CHANNELS = env("CHANNELS", 1000);
const MSGS = env("MSGS", 50);
const USERS = env("USERS", 10_000);
const WRITE_PCT = env("WRITE_PCT", 10);
const CONC = env("CONC", 32);
const SECS = env("SECS", 10);
const ROUNDS = env("ROUNDS", 2);
const SKEW = env("SKEW", 1.0);
const SCENARIO = process.env.SCENARIO ?? "mixed";

async function openStore(): Promise<Persistence> {
  if (KIND === "memory") return MemoryPersistence.open(null, { durable: false });
  if (KIND === "sqlite") return new SqlitePersistence(":memory:", { durable: true });
  if (KIND === "postgres") return (await import("./drivers/postgres.ts")).open(true);
  if (KIND === "mysql") return (await import("./drivers/mysql.ts")).open(true);
  throw new Error(`PERSISTENCE=${KIND}?`);
}

// Persistence calls, counted under the engine.
const calls = { scan: 0, get: 0 };
function counted(p: Persistence): Persistence {
  return new Proxy(p, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== "function") return value;
      if (prop === "scan" || prop === "get") {
        return (...args: unknown[]) => {
          calls[prop]++;
          return value.apply(target, args);
        };
      }
      return value.bind(target);
    },
  });
}

// A Zipf-like draw over [0, n): weight 1/(i+1)^s, by inverse CDF on a precomputed table.
function zipf(n: number, s: number): () => number {
  const cdf = new Float64Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) cdf[i] = sum += 1 / (i + 1) ** s;
  return () => {
    const x = Math.random() * sum;
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (cdf[mid]! < x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
}

const schema = defineSchema({
  channels: defineTable(v.any()),
  messages: defineTable(v.any()).index("by_channel", ["channel"]),
  users: defineTable(v.any()),
  settings: defineTable(v.any()),
});
const engine = await new Engine(schema, counted(await openStore()), { indexCache: {} }).init();

// Seed.
const t0 = performance.now();
const settingsId: string = await engine.mutation((db) => db.insert("settings", { maxLen: 2000, slowMode: false }));
const channelIds: string[] = [];
for (let c = 0; c < CHANNELS; c += 200)
  channelIds.push(
    ...(await engine.mutation(async (db) => {
      const out: string[] = [];
      for (let i = c; i < Math.min(CHANNELS, c + 200); i++) out.push(await db.insert("channels", { name: `c${i}` }));
      return out;
    })),
  );
const userIds: string[] = [];
for (let u = 0; u < USERS; u += 500)
  userIds.push(
    ...(await engine.mutation(async (db) => {
      const out: string[] = [];
      for (let i = u; i < Math.min(USERS, u + 500); i++) out.push(await db.insert("users", { name: `u${i}` }));
      return out;
    })),
  );
for (let c = 0; c < CHANNELS; c++)
  await engine.mutation(async (db) => {
    for (let m = 0; m < MSGS; m++) await db.insert("messages", { channel: channelIds[c], body: "x".repeat(120), m });
  });
const seedMs = Math.round(performance.now() - t0);

const pickChannel = zipf(CHANNELS, SKEW);
const pickUser = zipf(USERS, SKEW);

const listFor = (user: string, channel: string) => async (db: any) => {
  const me = await db.get(user);
  const settings = await db.get(settingsId);
  const msgs = await db
    .query("messages")
    .withIndex("by_channel", (q: any) => q.eq("channel", channel))
    .order("desc")
    .take(20);
  return { me: me.name, slow: settings.slowMode, n: msgs.length };
};
const send = (user: string, channel: string) => async (db: any) => {
  const me = await db.get(user);
  const settings = await db.get(settingsId);
  const ch = await db.get(channel);
  if (!me || !ch || settings.slowMode) throw new Error("no");
  await db.insert("messages", { channel, body: "y".repeat(120), m: -1 });
};

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return Number((s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0).toFixed(3));
};

let phaseNo = 0;
async function phase(on: boolean) {
  phaseNo++;
  // Fresh caches: a new index cache, and query-cache keys no earlier phase used.
  (engine as any).indexCache = on ? new IndexCache(engine.committer, env("INDEX_CACHE_MB", 64) * 2 ** 20) : null;
  const ns = `p${phaseNo}`;
  calls.scan = calls.get = 0;
  const qLat: number[] = [];
  const mLat: number[] = [];
  let unique = 0;
  const hits0 = engine.stats.cacheHits;
  const end = performance.now() + SECS * 1000;
  await Promise.all(
    Array.from({ length: CONC }, async () => {
      while (performance.now() < end) {
        const user = userIds[pickUser()]!;
        const channel = channelIds[pickChannel()]!;
        const s = performance.now();
        if (SCENARIO !== "queries" && Math.random() * 100 < WRITE_PCT) {
          await engine.mutation(send(user, channel));
          mLat.push(performance.now() - s);
        } else {
          const key = SCENARIO === "unique" ? `${ns}:${unique++}` : `${ns}:${user}:${channel}`;
          await engine.query(listFor(user, channel), key);
          qLat.push(performance.now() - s);
        }
      }
    }),
  );
  const ops = qLat.length + mLat.length;
  const ic = (engine as any).indexCache as IndexCache | null;
  const icHits = ic ? ic.stats.hits / Math.max(1, ic.stats.hits + ic.stats.misses) : 0;
  const out = {
    phase: phaseNo,
    indexCache: on ? "on" : "off",
    opsPerSec: Math.round(ops / SECS),
    queriesPerSec: Math.round(qLat.length / SECS),
    mutationsPerSec: Math.round(mLat.length / SECS),
    queryP50: pct(qLat, 0.5),
    queryP99: pct(qLat, 0.99),
    mutationP50: pct(mLat, 0.5),
    mutationP99: pct(mLat, 0.99),
    queryCacheHitRate: Number(((engine.stats.cacheHits - hits0) / Math.max(1, qLat.length)).toFixed(3)),
    indexCacheHitRate: Number(icHits.toFixed(3)),
    indexCacheMB: ic ? Number((ic.stats.bytes / 2 ** 20).toFixed(1)) : 0,
    storeCallsPerOp: Number(((calls.scan + calls.get) / Math.max(1, ops)).toFixed(3)),
    storeCallsPerSec: Math.round((calls.scan + calls.get) / SECS),
  };
  console.log(JSON.stringify(out));
  return out;
}

console.log(JSON.stringify({ KIND, SCENARIO, CHANNELS, MSGS, USERS, WRITE_PCT, CONC, SECS, ROUNDS, SKEW, seedMs }));
await phase(false); // warm-up, not reported in the summary
for (let r = 0; r < ROUNDS; r++) {
  await phase(false);
  await phase(true);
}
await engine.close?.();
process.exit(0);
