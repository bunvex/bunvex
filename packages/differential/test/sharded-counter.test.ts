// The sharded counter (STUDY-183) on Convex's backend (the oracle) with `@convex-dev/sharded-counter` 0.2.3, and on
// bunvex's with `@bunvex/sharded-counter`: the same app (sharded-counter-app/) makes the same calls on both, and the
// test compares what an app sees:
// - the counts and every result, after the component's functions and its client's methods;
// - the component's table, read with each CLI's `run --component … --inline-query`: its rows without ids and creation
//   times, sorted;
// - the errors of bad arguments, word for word;
// - the trigger with the helpers' triggers (convex-helpers 0.1.128 there, `@bunvex/helpers` here).
// What is random on each backend (the shard `add` picks, the shards `estimateCount` reads) is compared through
// invariants: the counts are exact, every picked shard is below `shards`, an estimate is one its own rows allow.
// Local only: skipped, with a note, when Convex's backend is not there (scripts/download-convex-backend.sh, or
// CONVEX_BACKEND_BIN).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Backend, ORACLE_BIN, startBunvex, startConvex } from "../harness/backends.ts";

const ready = existsSync(ORACLE_BIN);
if (!ready) console.warn(`sharded-counter: skipped, no Convex backend at ${ORACLE_BIN} (set CONVEX_BACKEND_BIN)`);

const APP = resolve(import.meta.dir, "../sharded-counter-app");
let convex: Backend;
let bunvex: Backend;

/** bunvex's project installs `@bunvex/sharded-counter` and `@bunvex/helpers` where Convex's has Convex's packages. */
function prepare(project: string, dir: "convex" | "bunvex") {
  if (dir !== "bunvex") return;
  const functions = join(project, dir);
  renameSync(join(functions, "convex.config.ts"), join(functions, "bunvex.config.ts"));
  for (const name of ["bunvex.config.ts", "counter.ts"]) {
    const file = join(functions, name);
    writeFileSync(
      file,
      readFileSync(file, "utf8")
        .replaceAll('"@convex-dev/sharded-counter/convex.config"', '"@bunvex/sharded-counter/bunvex.config.js"')
        .replaceAll('"@convex-dev/sharded-counter"', '"@bunvex/sharded-counter"')
        .replaceAll('"convex-helpers/server/', '"@bunvex/helpers/server/'),
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

const value = (b: Backend, r: { ok: boolean; body: unknown }) => {
  if (!r.ok) throw new Error(`${b.name}: call failed: ${JSON.stringify(r.body)}`);
  return (r.body as { value: unknown }).value;
};
/** A mutation of the app on both backends, one after the other: each one's result. */
const both = async (path: string, args: Record<string, unknown>) => {
  const out: unknown[] = [];
  for (const b of [convex, bunvex]) out.push(value(b, await b.call("mutation", path, args)));
  return out as [unknown, unknown];
};
const bothQuery = async (path: string, args: Record<string, unknown>) => {
  const out: unknown[] = [];
  for (const b of [convex, bunvex]) out.push(value(b, await b.call("query", path, args)));
  return out as [unknown, unknown];
};
/** A component function on both: `{ ok }` or `{ error }`, compared. */
const call = (fn: string, args: unknown, mount?: string) => both("counter:call", { fn, args, mount });

type Row = { name: string; shard: number; value: number };
/** The component's rows on one backend, read by its CLI in the component: without system fields, sorted. */
async function rows(b: Backend, mount = "shardedCounter"): Promise<Row[]> {
  const query =
    'return JSON.stringify((await ctx.db.query("counters").collect()).map((r) => [r.name, r.shard, r.value, Object.keys(r).sort()]))';
  const out = await b.cli(["run", "--component", mount, "--inline-query", query]);
  // Each CLI prints the returned string as JSON: a JSON string of the JSON text.
  const text = JSON.parse(out.trim()) as string;
  const parsed = JSON.parse(text) as [string, number, number, string[]][];
  for (const [, , , keys] of parsed) expect(keys).toEqual(["_creationTime", "_id", "name", "shard", "value"]);
  return parsed
    .map(([name, shard, value]) => ({ name, shard, value }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.shard - b.shard || a.value - b.value));
}
const bothRows = async (mount?: string) => [await rows(convex, mount), await rows(bunvex, mount)];

describe.skipIf(!ready)("the sharded counter: Convex with @convex-dev/sharded-counter 0.2.3, bunvex with ours", () => {
  test("explicit shards, rebalance (fractions, more and fewer shards, the default) and reset: the same rows", async () => {
    const steps: [string, unknown][] = [
      ["add", { name: "a", count: 10, shard: 0 }],
      ["add", { name: "a", count: 5, shard: 3 }],
      ["add", { name: "a", count: -2.5, shard: 3 }],
      ["add", { name: "b", count: 7, shard: 1 }],
      ["add", { name: "odd", count: 4, shard: -1 }],
      ["add", { name: "odd", count: 2, shard: 0.5 }],
      ["add", { name: "odd", count: 1, shard: 7 }],
      ["count", { name: "a" }],
      ["rebalance", { name: "a", shards: 3 }],
      ["count", { name: "a" }],
      ["rebalance", { name: "b", shards: 5 }],
      ["rebalance", { name: "odd", shards: 2 }],
      ["rebalance", { name: "c" }],
      ["rebalance", { name: "a" }],
      ["rebalance", { name: "a", shards: 2 }],
      ["estimateCount", { name: "a", shards: 2, readFromShards: 2 }],
      ["estimateCount", { name: "a", shards: 2, readFromShards: 50 }],
      ["estimateCount", { name: "b", shards: 5, readFromShards: 5 }],
      ["reset", { name: "b" }],
      ["count", { name: "b" }],
    ];
    for (const [fn, args] of steps) {
      const [c, b] = await call(fn, args);
      expect({ fn, args, result: b }).toEqual({ fn, args, result: c });
      const [rc, rb] = await bothRows();
      expect({ fn, args, rows: rb }).toEqual({ fn, args, rows: rc });
    }
    // The second mount is a counter of its own.
    expect(await call("add", { name: "a", count: 1, shard: 0 }, "second")).toEqual([{ ok: 0 }, { ok: 0 }]);
    const [c2, b2] = await bothRows("second");
    expect(b2).toEqual(c2);
    expect(c2).toEqual([{ name: "a", shard: 0, value: 1 }]);
  }, 120_000);

  test("random shards: every pick below `shards` (16 by default), the counts exact", async () => {
    for (const b of [convex, bunvex]) {
      const picks: number[] = [];
      for (let i = 0; i < 40; i++)
        picks.push(
          (
            value(b, await b.call("mutation", "counter:call", { fn: "add", args: { name: "r", count: 1 } })) as {
              ok: number;
            }
          ).ok,
        );
      for (let i = 0; i < 20; i++)
        picks.push(
          (
            value(
              b,
              await b.call("mutation", "counter:call", { fn: "add", args: { name: "r5", count: 2, shards: 5 } }),
            ) as { ok: number }
          ).ok,
        );
      for (const [i, p] of picks.entries()) {
        expect(Number.isInteger(p)).toBe(true);
        expect(p).toBeGreaterThanOrEqual(0);
        expect(p).toBeLessThan(i < 40 ? 16 : 5);
      }
      // 40 draws over 16 shards land on more than one.
      expect(new Set(picks.slice(0, 40)).size).toBeGreaterThan(1);
      const own = await rows(b);
      expect(own.filter((r) => r.name === "r").reduce((s, r) => s + r.value, 0)).toBe(40);
      expect(own.filter((r) => r.name === "r5").reduce((s, r) => s + r.value, 0)).toBe(40);
      expect(new Set(own.filter((r) => r.name === "r").map((r) => r.shard))).toEqual(new Set(picks.slice(0, 40)));
    }
    expect(await bothQuery("counter:read", { fn: "count", args: { name: "r" } })).toEqual([40, 40]);
  }, 120_000);

  test("estimateCount: an estimate each backend's own rows allow; exact after a rebalance", async () => {
    for (const b of [convex, bunvex]) {
      const own = (await rows(b)).filter((r) => r.name === "r");
      const byShard = new Map(own.map((r) => [r.shard, r.value]));
      // One shard of 16 read, scaled by 16.
      const one = value(b, await b.call("query", "counter:read", { fn: "estimateCount", args: { name: "r" } }));
      expect(Array.from({ length: 16 }, (_, s) => (byShard.get(s) ?? 0) * 16)).toContain(one as number);
      // Two shards of 4 read (only shards 0..3 are listed), scaled by 4 / 2.
      const values = [0, 1, 2, 3].map((s) => byShard.get(s) ?? 0);
      const pairs = values.flatMap((x, i) => values.slice(i + 1).map((y) => ((x + y) * 4) / 2));
      const two = value(
        b,
        await b.call("query", "counter:read", {
          fn: "estimateCount",
          args: { name: "r", shards: 4, readFromShards: 2 },
        }),
      );
      expect(pairs).toContain(two as number);
    }
    await call("rebalance", { name: "r" });
    for (const readFromShards of [0, 1, 7, 16, 99])
      expect(await bothQuery("counter:read", { fn: "estimateCount", args: { name: "r", readFromShards } })).toEqual([
        40, 40,
      ]);
  }, 120_000);

  test("bad arguments: the same errors (the server's nested-call gap aside, pinned below)", async () => {
    const cases: [string, unknown][] = [
      ["add", { name: "a" }],
      ["add", { name: "a", count: "1" }],
      ["add", { name: 1, count: 1 }],
      ["add", { name: "a", count: 1, shard: "0" }],
      ["add", { name: "a", count: 1, extra: true }],
      ["count", {}],
      ["count", { name: null }],
      ["rebalance", { name: "a", shards: "3" }],
      ["reset", { name: "a", shards: 3 }],
      ["estimateCount", { name: "a", readFromShards: "2" }],
      ["estimateCount", { name: "a", shards: { $integer: "AQAAAAAAAAA=" } }],
    ];
    // A gap of bunvex's server, not of the component, found here: a nested call's argument error, as the caller
    // catches it, ends with one newline more than Convex's ("…\n\n" for "…\n"; left uncaught, Convex's also reads
    // "Uncaught Error: …" with the caller's frame). Every other character is compared; the pin fails once it is fixed.
    const NESTED_GAP = "\n";
    const differences: unknown[] = [];
    for (const [fn, args] of cases) {
      const [c, b] = (await call(fn, args)) as { error?: string }[];
      expect(c).toHaveProperty("error");
      if (`${c!.error}${NESTED_GAP}` !== b!.error) differences.push({ fn, args, convex: c, bunvex: b });
    }
    expect(differences).toEqual([]);
  }, 120_000);

  test("the client: its methods and defaults, for(name), the remembered shard", async () => {
    const ops = [
      { op: "add", name: "k" },
      { op: "add", name: "k", count: 5 },
      { op: "subtract", name: "k" },
      { op: "subtract", name: "k", count: 2 },
      { op: "inc", name: "k" },
      { op: "dec", name: "k" },
      { op: "count", name: "k" },
      { op: "add", name: "f", via: "for" },
      { op: "add", name: "f", count: 3, via: "for" },
      { op: "subtract", name: "f", via: "for" },
      { op: "subtract", name: "f", count: 2, via: "for" },
      { op: "inc", name: "f", via: "for" },
      { op: "dec", name: "f", via: "for" },
      { op: "count", name: "f", via: "for" },
      { op: "rebalance", name: "k" },
      { op: "count", name: "k" },
      { op: "estimateCount", name: "k", readFromShards: 3 },
      { op: "rebalance", name: "f", via: "for" },
      { op: "estimateCount", name: "f", via: "for" },
      { op: "estimateCount", name: "f", readFromShards: 2, via: "for" },
      { op: "reset", name: "k" },
      { op: "count", name: "k" },
      { op: "reset", name: "f", via: "for" },
    ];
    const options = { shards: { k: 3 }, defaultShards: 2 };
    const [c, b] = await both("counter:client", { options, ops });
    expect(b).toEqual(c);
    expect(c).toEqual([
      null,
      null,
      null,
      null,
      null,
      null,
      3,
      null,
      null,
      null,
      null,
      null,
      null,
      1,
      null,
      3,
      3,
      null,
      1,
      1,
      null,
      0,
      null,
    ]);
    // One instance, one shard per counter: 30 adds in one mutation land on one row, on both.
    const thirty = Array.from({ length: 30 }, () => ({ op: "inc", name: "sticky" }));
    await both("counter:client", { keep: true, ops: thirty });
    for (const b of [convex, bunvex]) {
      const own = (await rows(b)).filter((r) => r.name === "sticky");
      expect(own).toHaveLength(1);
      expect(own[0]!.value).toBe(30);
      expect(own[0]!.shard).toBeLessThan(10);
    }
  }, 120_000);

  test("trigger(name) with the helpers' triggers: the counter follows the table", async () => {
    expect(await both("counter:users", { insert: 5, rename: 2, remove: 0 })).toEqual([5, 5]);
    expect(await both("counter:users", { insert: 0, rename: 3, remove: 2 })).toEqual([3, 3]);
    expect(await bothQuery("counter:read", { fn: "count", args: { name: "users" } })).toEqual([3, 3]);
  }, 120_000);
});
