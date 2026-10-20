// The query cache as an app can observe it (STUDY-174 §3), on Convex's backend (the oracle) and on bunvex's: whether
// each query call was answered from the cache, read from the function log stream (`/api/stream_function_logs`,
// `cachedResult`). A query that reads no time stays cached until a commit writes into what it read; a write
// elsewhere leaves it; one that read the clock is served for 17 s at most (Convex's MAX_CACHE_AGE). Results alone
// cannot show any of this: a miss answers the same value as a hit. A hit's entry also gives the user time, memory,
// execution timestamp and identity of the run it reused (STUDY-174 §10.2). Local only: skipped, with a note, when Convex's
// backend is not there (scripts/download-convex-backend.sh, or CONVEX_BACKEND_BIN).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { type Backend, ORACLE_BIN, startBunvex, startConvex } from "../harness/backends.ts";

const ready = existsSync(ORACLE_BIN);
if (!ready) console.warn(`cache-metadata: skipped, no Convex backend at ${ORACLE_BIN} (set CONVEX_BACKEND_BIN)`);

const APP = resolve(import.meta.dir, "../cache-app");
/** Convex's MAX_CACHE_AGE (crates/common/src/knobs.rs: the query timeouts plus 1 s), and a margin past it. */
const PAST_MAX_CACHE_AGE_MS = 17_000 + 2_000;

let convex: Backend;
let bunvex: Backend;

beforeAll(async () => {
  if (!ready) return;
  [convex, bunvex] = await Promise.all([startConvex({ app: APP }), startBunvex({ app: APP })]);
}, 300_000);

afterAll(async () => {
  await Promise.all([convex?.stop(), bunvex?.stop()]);
});

type Entry = {
  kind?: string;
  identifier?: string;
  udfType?: string;
  cachedResult?: boolean;
  userExecutionTime?: number;
  executionTimestamp?: number;
  timestamp?: number;
  identityType?: string;
  requestId?: string;
  executionId?: string;
  caller?: string;
  usageStats?: { memoryUsedMb?: number; databaseReadDocuments?: number };
};

/** The query entries the last `observe` read, in order. */
const lastEntries: Entry[] = [];

/** The log stream's cursor after what a backend has logged so far, by backend. */
const cursors = new Map<Backend, number>();

/**
 * Run `calls` on `b` in order, then the cache flag of each query call that the function log stream recorded after
 * them, as `name:hit` or `name:miss`.
 */
async function observe(b: Backend, calls: [kind: "query" | "mutation", name: string][]): Promise<string[]> {
  for (const [kind, name] of calls) {
    const r = await b.call(kind, `cache:${name}`, {});
    expect(r.ok).toBe(true);
  }
  const want = calls.filter(([k]) => k === "query").length;
  const auth = `${b.name === "convex" ? "Convex" : "Bunvex"} ${b.adminKey}`;
  const seen: string[] = [];
  lastEntries.length = 0;
  let cursor = cursors.get(b) ?? 0;
  for (let i = 0; i < 100 && seen.length < want; i++) {
    const r = await fetch(`${b.url}/api/stream_function_logs?cursor=${cursor}`, { headers: { authorization: auth } });
    const body = (await r.json()) as { entries: Entry[]; newCursor: number };
    for (const e of body.entries)
      if (e.kind === "Completion" && e.udfType === "Query" && e.identifier?.startsWith("cache")) {
        seen.push(`${e.identifier.replace(/^cache(\.js)?:/, "")}:${e.cachedResult ? "hit" : "miss"}`);
        lastEntries.push(e);
      }
    cursor = body.newCursor;
    if (seen.length < want) await Bun.sleep(100);
  }
  cursors.set(b, cursor);
  return seen;
}

/** The same calls on both backends: bunvex's cache flags must be Convex's. */
async function same(calls: [kind: "query" | "mutation", name: string][]) {
  const c = await observe(convex, calls);
  expect(await observe(bunvex, calls)).toEqual(c);
  return c;
}

describe.skipIf(!ready)("the query cache's observable behaviour, against Convex's backend", () => {
  test("a repeated query hits; a write elsewhere keeps it; a write into its reads invalidates it", async () => {
    expect(
      await same([
        ["query", "plain"],
        ["query", "plain"],
        ["mutation", "other"],
        ["query", "plain"],
        ["mutation", "add"],
        ["query", "plain"],
        ["query", "clock"],
        ["query", "clock"],
      ]),
    ).toEqual(["plain:miss", "plain:hit", "plain:hit", "plain:miss", "clock:miss", "clock:hit"]);
  });

  // The 17 s expiry is a wall-clock one on both sides: this test waits it out.
  test("past 17 s, a query that read no time is still cached, and one that read the clock is not", async () => {
    await Bun.sleep(PAST_MAX_CACHE_AGE_MS);
    expect(
      await same([
        ["query", "plain"],
        ["query", "clock"],
      ]),
    ).toEqual(["plain:hit", "clock:miss"]);
  }, 60_000);

  // STUDY-174 finding F4: a hit's entry describes the run it reused, as Convex's `log_query`
  // (crates/application/src/function_log.rs) logs the cached outcome's user time, memory, execution timestamp and
  // identity, with the hit's own log time, request, execution id and caller, and no reads.
  test("a hit's log entry carries the user time, memory and timestamp of the run it reused", async () => {
    const shape = async (b: Backend) => {
      await b.call("mutation", "cache:add", {});
      await observe(b, [
        ["query", "plain"],
        ["query", "plain"],
      ]);
      const [miss, hit] = lastEntries;
      return {
        flags: [miss?.cachedResult, hit?.cachedResult],
        sameUserTime: hit?.userExecutionTime === miss?.userExecutionTime,
        sameMemory: hit?.usageStats?.memoryUsedMb === miss?.usageStats?.memoryUsedMb,
        memoryUsedMb: hit?.usageStats?.memoryUsedMb,
        sameTimestamp: hit?.executionTimestamp === miss?.executionTimestamp,
        sameIdentityType: hit?.identityType === miss?.identityType,
        // The hit's own: logged no earlier than its run (both clocks are coarse), in its own request and execution,
        // by its own caller.
        loggedAtOrAfterRun: (hit?.timestamp ?? 0) >= (miss?.timestamp ?? 0),
        sameRequestId: hit?.requestId === miss?.requestId,
        sameExecutionId: hit?.executionId === miss?.executionId,
        caller: hit?.caller,
        hitReads: hit?.usageStats?.databaseReadDocuments,
      };
    };
    const c = await shape(convex);
    expect(c).toMatchObject({ flags: [false, true], sameUserTime: true, sameMemory: true, sameTimestamp: true });
    expect(await shape(bunvex)).toEqual(c);
  });
});
