// SPIKE (STUDY-194 2b, owner 2026-11-01): a query worker, not product code. Its own reader engine on the store the
// main thread writes (a read-only SQLite connection, the catalog at start), the bench's functions registered, and
// the call runner: a request's text in, its outcome's text out. Nothing it holds follows a push or a new table.
import { Engine } from "@bunvex/core";
import { SqlitePersistence } from "@bunvex/core/persistence/sqlite";
import { Functions } from "bunvex/server";
import { type Interval, type LogEntry, overlaps } from "../../packages/core/src/committer.ts";
import { IndexCache } from "../../packages/core/src/index-cache.ts";
import { bench, benchSchema } from "../functions.ts";

declare const self: Worker;

type Init = { path: string; instanceSecret: string; instanceName: string; cacheBytes?: number };
const stats = { ms: 0, n: 0 };
if (process.env.SPIKE_STATS)
  setInterval(() => {
    if (stats.n) console.error(`worker: ${stats.n} calls, ${((stats.ms / stats.n) * 1000).toFixed(0)} µs/call`);
    stats.ms = 0;
    stats.n = 0;
  }, 5000).unref();
/**
 * The main thread's write log as this worker hears it (each commit posted before any request at or past its ts):
 * what the index cache checks an entry against, as it checks the committer's in the main thread.
 */
const log = {
  visibleTs: 0n,
  /** The newest ts of the commits dropped from `entries`. */
  purgedTs: 0n,
  entries: [] as LogEntry[],
  changedBetween(reads: Interval[], from: bigint, to: bigint) {
    if (from >= to) return false;
    // Older than what the log still holds: nothing can be proven.
    if (from < log.purgedTs) return true;
    for (let i = log.entries.length - 1; i >= 0; i--) {
      const e = log.entries[i]!;
      if (e.ts <= from) break;
      if (e.ts <= to && overlaps(e.writes, reads)) return true;
    }
    return false;
  },
};
const KEEP = 20000;
let ready: Promise<{ engine: Engine; functions: Functions }> | null = null;

self.onmessage = async (e: MessageEvent<Init | [number, string, bigint] | ["c", LogEntry[]]>) => {
  const m = e.data;
  if (Array.isArray(m) && m[0] === "c") {
    for (const entry of m[1] as LogEntry[]) {
      log.entries.push(entry);
      if (entry.ts > log.visibleTs) log.visibleTs = entry.ts;
    }
    if (log.entries.length > KEEP) {
      const dropped = log.entries.splice(0, log.entries.length - KEEP);
      log.purgedTs = dropped[dropped.length - 1]!.ts;
    }
    return;
  }
  if (!Array.isArray(m)) {
    ready = (async () => {
      const p = new SqlitePersistence(m.path, { durable: false, reader: true, cacheBytes: m.cacheBytes });
      const engine = await new Engine(benchSchema, p, {
        instanceSecret: m.instanceSecret,
        instanceName: m.instanceName,
      }).openReader();
      const functions = new Functions(engine).register("bench", bench);
      if (process.env.SPIKE_INDEX_CACHE !== "0") (engine as any).indexCache = new IndexCache(log as never, 256 * 1024 * 1024, 0);
      return { engine, functions };
    })();
    await ready;
    self.postMessage("ready");
    return;
  }
  const [id, request, ts] = m as [number, string, bigint];
  if (ts > log.visibleTs) log.visibleTs = ts;
  try {
    const { engine, functions } = await ready!;
    const t0 = performance.now();
    const outcome = await engine.runCallText(request, functions.spikeBodies);
    stats.ms += performance.now() - t0;
    stats.n++;
    self.postMessage([id, outcome]);
  } catch (e) {
    console.error("query worker:", e);
    self.postMessage([id, null, String((e as Error)?.stack ?? e)]);
  }
};
