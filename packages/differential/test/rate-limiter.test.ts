// The rate limiter (STUDY-197) on Convex's backend (the oracle) with `@convex-dev/rate-limiter` 0.4.2, and on
// bunvex's with `@bunvex/rate-limiter`: the same app (rate-limiter-app/) makes the same calls on both, with limits
// that barely refill (3 a year) so that no result depends on when each backend ran it. It compares:
// - runs of `limit` (ok, the presence of `retryAfter`, the `RateLimited` error's data and `isRateLimitError`);
// - `getValue` and `reset`;
// - the asynchronous mode once the batch worker has drained it;
// - the component's rows, read with each CLI's `run --component … --inline-query`, without ids and times;
// - the errors of bad arguments and the client's own refusals, word for word. The error class is the one place they
//   differ (`ConvexError`, `BunvexError`: DV-538), and is compared without it.
// Local only: skipped, with a note, when Convex's backend is not there.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Backend, ORACLE_BIN, startBunvex, startConvex } from "../harness/backends.ts";

const ready = existsSync(ORACLE_BIN);
if (!ready) console.warn(`rate-limiter: skipped, no Convex backend at ${ORACLE_BIN} (set CONVEX_BACKEND_BIN)`);

const APP = resolve(import.meta.dir, "../rate-limiter-app");
let convex: Backend;
let bunvex: Backend;

/** bunvex's project installs `@bunvex/rate-limiter` where Convex's has `@convex-dev/rate-limiter`. */
function prepare(project: string, dir: "convex" | "bunvex") {
  if (dir !== "bunvex") return;
  const functions = join(project, dir);
  renameSync(join(functions, "convex.config.ts"), join(functions, "bunvex.config.ts"));
  for (const name of ["bunvex.config.ts", "limits.ts"]) {
    const file = join(functions, name);
    writeFileSync(
      file,
      readFileSync(file, "utf8")
        .replaceAll('"@convex-dev/rate-limiter/convex.config"', '"@bunvex/rate-limiter/bunvex.config.js"')
        .replaceAll('"@convex-dev/rate-limiter"', '"@bunvex/rate-limiter"'),
    );
  }
}

beforeAll(async () => {
  if (!ready) return;
  [convex, bunvex] = await Promise.all([startConvex({ app: APP, prepare }), startBunvex({ app: APP, prepare })]);
}, 300_000);
afterAll(async () => {
  await Promise.all([convex?.stop(), bunvex?.stop()]);
});

/** The error class is each product's own (DV-538); everything else is compared. */
const withoutClass = (x: unknown) =>
  JSON.parse(JSON.stringify(x).replaceAll("ConvexError", "<AppError>").replaceAll("BunvexError", "<AppError>"));
const value = async (b: Backend, kind: "query" | "mutation", path: string, args: Record<string, unknown>) => {
  const r = await b.call(kind, path, args);
  if (!r.ok) throw new Error(`${b.name}: call failed: ${JSON.stringify(r.body)}`);
  return withoutClass((r.body as { value: unknown }).value);
};
const both = async (kind: "query" | "mutation", path: string, args: Record<string, unknown>) =>
  [await value(convex, kind, path, args), await value(bunvex, kind, path, args)] as const;

/** The component's rows on one backend, read by its CLI in the component: without system fields and times, sorted. */
async function rows(b: Backend): Promise<unknown> {
  const query = `
    const all = await ctx.db.query("rateLimits").collect();
    // Which shards a sharded limit's calls landed on is each backend's randomness: compared as the tokens they took
    // (3 a shard, 10 shards).
    const shardedTaken = Math.round(all.filter((r) => r.name === "sharded").reduce((n, r) => n + 3 - r.value, 0) * 1e6) / 1e6;
    const limits = all.filter((r) => r.name !== "sharded").map((r) => [r.name, r.key ?? null, r.shard, Math.round(r.value * 1e6) / 1e6, Object.keys(r).sort()]);
    const pending = (await ctx.db.query("pendingUpdates").collect()).length;
    return JSON.stringify({ limits: limits.sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1), shardedTaken, pending });`;
  return JSON.parse(JSON.parse((await b.cli(["run", "--component", "rateLimiter", "--inline-query", query])).trim()));
}

/** Until the asynchronous queue is empty on `b` (the batch worker drains it on the backend's own scheduler). */
async function drained(b: Backend) {
  const deadline = Date.now() + 30_000;
  while (((await rows(b)) as { pending: number }).pending > 0 && Date.now() < deadline) await Bun.sleep(200);
}

describe.skipIf(!ready)("the rate limiter: Convex with @convex-dev/rate-limiter 0.4.2, bunvex with ours", () => {
  test("transactional limits: runs of limit, the RateLimited error, getValue and reset", async () => {
    const runs: [string, unknown[]][] = [
      ["bucket", [{}, {}, { key: "k" }, {}, {}, { throws: true }]],
      ["window", [{ count: 2 }, {}, {}, { throws: true }]],
      ["reserved", [{ count: 3 }, { reserve: true, count: 2 }, { reserve: true }]],
      ["sharded", [{}, {}, {}, { count: 2 }]],
    ];
    for (const [name, calls] of runs) {
      const [c, x] = await both("mutation", "limits:limit", { name, calls });
      expect({ name, result: x }).toEqual({ name, result: c });
    }
    for (const name of ["bucket", "window", "reserved"]) {
      const [c, x] = await both("query", "limits:value", { name });
      expect({ name, value: x }).toEqual({ name, value: c });
    }
    await both("mutation", "limits:reset", { name: "bucket" });
    const [c, x] = await both("query", "limits:value", { name: "bucket" });
    expect(x).toEqual(c);
  }, 60_000);

  test("the asynchronous mode drains to the same values", async () => {
    const [c, x] = await both("mutation", "limits:limit", { name: "queued", calls: [{}, {}, { key: "a" }, {}, {}] });
    expect(x).toEqual(c);
    await Promise.all([drained(convex), drained(bunvex)]);
    for (const key of [undefined, "a"]) {
      const [cv, xv] = await both("query", "limits:value", { name: "queued", ...(key ? { key } : {}) });
      expect({ key, value: xv }).toEqual({ key, value: cv });
    }
    expect(await rows(bunvex)).toEqual(await rows(convex));
  }, 60_000);

  test("bad arguments and the client's refusals: the same errors", async () => {
    const YEAR = 365 * 24 * 60 * 60 * 1000;
    const bucket = { kind: "token bucket", rate: 3, period: YEAR };
    const cases: [string, unknown][] = [
      ["rateLimit", { name: "big", count: 4, config: bucket }],
      ["rateLimit", { name: "big", count: 9, reserve: true, config: { ...bucket, maxReserved: 2 } }],
      ["rateLimit", { name: "big", count: 4, config: { ...bucket, shards: 4, capacity: 8 } }],
      ["rateLimit", { name: "zero", config: { ...bucket, shards: 0.2 } }],
      ["rateLimit", { name: "async", config: { ...bucket, applyUpdates: "asynchronously" } }],
      [
        "enqueueUpdates",
        {
          updates: [
            { kind: "consume", name: "eager", count: 1, config: { ...bucket, applyUpdates: "transactionally" }, ts: 0 },
          ],
        },
      ],
      ["rateLimit", { name: "typo", config: { ...bucket, kind: "leaky bucket" } }],
      ["resetRateLimit", { name: 1 }],
    ];
    for (const [fn, args] of cases) {
      const [c, x] = await both("mutation", "limits:call", { fn, args });
      expect({ fn, args, result: x }).toEqual({ fn, args, result: c });
    }
    for (const which of ["undefined", "asyncSharded"]) {
      const [c, x] = await both("mutation", "limits:clientError", { which });
      expect({ which, result: x }).toEqual({ which, result: c });
    }
  }, 60_000);

  test("the component's rows", async () => {
    expect(await rows(bunvex)).toEqual(await rows(convex));
  });
});
