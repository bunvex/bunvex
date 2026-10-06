// The subscriptions and invalidation inspector's endpoints (STUDY-131 AD-25, a bunvex addition: Convex exposes
// no read set, and says nowhere why a query ran again). Admin only, with ViewMetrics, read-only:
//
// - `GET /api/debug/subscriptions[?path=]`: per sync session and live query, its function, an args digest,
//   the ts it is at, whether its last result came from another run (`cached`), what it read (documents, bytes,
//   and the read set as index ranges with their bounds read back to values), and the last invalidations or
//   reruns of its execution (`history`, newest first);
// - `GET /api/debug/query_cache[?path=&limit=]`: the HTTP query cache's counters (misses by reason), and its
//   biggest entries with their read sets;
// - `GET /api/debug/invalidations?cursor=[&path=&timeoutMs=]`: invalidations after `cursor`, as a long poll
//   (the log streams' style) for a screen that follows them.
//
// Everything is decoded here, when asked; the sync hub only keeps bytes (sync-inspector.ts).
import {
  boundText,
  type CacheEntry,
  type Caller,
  describeBound,
  type Engine,
  type Interval,
  type KeyBound,
  type KeyValue,
} from "@bunvex/core";
import { type JSONValue, toJsonValue, type Value } from "@bunvex/values";
import type { Functions } from "./functions.ts";
import type { Execution, SyncHub } from "./sync.ts";
import { argsDigest, type FeedRecord, type HistoryRecord } from "./sync-inspector.ts";

export const DEBUG_ROUTE = /^\/api\/debug\/(subscriptions|query_cache|invalidations)$/;
/** The longest a follow request waits for an invalidation, as the log streams' long poll. */
const FOLLOW_MAX_MS = 60_000;

type Ctx = { engine: Engine; functions: Functions; sync: SyncHub };

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export { argsDigest };

const keyValueJson = (v: KeyValue): JSONValue => (v === undefined ? null : toJsonValue(v as Value));

/** A bound as JSON: its kind, the values (a missing field as null; `text` says `undefined`), `after`. */
function boundJson(b: KeyBound) {
  if (b.kind === "key") return { kind: "key", values: b.values.map(keyValueJson), after: b.after, text: boundText(b) };
  if (b.kind === "raw") return { kind: "raw", hex: b.hex, text: boundText(b) };
  return { kind: b.kind, text: boundText(b) };
}

function readSetJson(ctx: Ctx, reads: readonly Interval[]) {
  return reads.map((r) => {
    const ix = ctx.sync.indexOf(r.index);
    const lo = describeBound(r.lo, true);
    const hi = describeBound(r.hi, false);
    return {
      index: ix ? `${ix.table}.${ix.name}` : `#${r.index}`,
      fields: ix?.fields ?? [],
      lo: boundJson(lo),
      hi: boundJson(hi),
      text: `[${boundText(lo)}, ${boundText(hi)})`,
    };
  });
}

function writtenKeyJson(ctx: Ctx, index: number, key: Uint8Array) {
  const ix = ctx.sync.indexOf(index);
  const b = describeBound(key, true);
  return {
    table: ix?.table ?? null,
    index: ix ? `${ix.table}.${ix.name}` : `#${index}`,
    key: boundJson(b),
  };
}

function historyJson(ctx: Ctx, h: HistoryRecord) {
  if (h.kind === "rerun") return { kind: "rerun", reason: h.reason, at: h.at };
  return {
    kind: "invalidation",
    seq: h.seq,
    at: h.at,
    commitTs: Number(h.commitTs),
    source: h.source,
    ...writtenKeyJson(ctx, h.index, h.key),
    sentAfterMs: h.sentAfterMs === null ? null : Math.round(h.sentAfterMs * 1000) / 1000,
  };
}

/** The path and canonical args of a sync execution key (`path\0args\0journal\0who`, a component first). */
function splitExecKey(key: string): { path: string; args: string } {
  const [head = "", args = ""] = key.split("\u0000");
  const i = head.indexOf("\u0001");
  return { path: i === -1 ? head : head.slice(i + 1), args };
}

const matches = (path: string, filter: string | null) => filter === null || filter === "" || path.includes(filter);

function subscriptions(ctx: Ctx, url: URL) {
  const filter = url.searchParams.get("path");
  const { sync } = ctx;
  const sessions = [];
  let queries = 0;
  for (const s of sync.sessions) {
    const info = s.inspect();
    const shown = [];
    for (const { queryId, q } of info.queries) {
      if (!matches(q.udfPath, filter)) continue;
      const exec: Execution | null = q.exec;
      shown.push({
        queryId,
        path: q.udfPath,
        argsDigest: argsDigest(q.argsJson),
        ts: exec ? Number(exec.ts) : null,
        validAt: Number(q.validAt),
        cached: q.cached === true,
        lastRunAt: q.lastRunAt ?? null,
        result: exec === null ? "pending" : exec.type === "QueryFailed" ? "error" : "value",
        documentsRead: exec?.documentsRead ?? 0,
        bytesRead: exec?.bytesRead ?? 0,
        readSet: readSetJson(ctx, exec?.reads ?? []),
        history: sync.inspector.history(q.key).map((h) => historyJson(ctx, h)),
      });
    }
    queries += shown.length;
    if (shown.length > 0 || filter === null)
      sessions.push({ sessionId: info.sessionId, identity: info.identity, queries: shown });
  }
  return {
    ts: Number(ctx.engine.committer.visibleTs),
    historySize: sync.inspector.size,
    sessions,
    totals: { sessions: sync.sessions.size, queries },
  };
}

/** An HTTP query cache key: `codeHash\0path\0args` then `\u0001` and whose result (`*` for everyone). */
function splitCacheKey(key: string): { path: string; args: string; shared: boolean } {
  const [, path = "", rest = ""] = key.split("\u0000");
  const i = rest.lastIndexOf("\u0001");
  return { path, args: i === -1 ? rest : rest.slice(0, i), shared: i !== -1 && rest.slice(i + 1) === "*" };
}

function queryCache(ctx: Ctx, url: URL) {
  const filter = url.searchParams.get("path");
  const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit") ?? 20) || 20));
  const { engine } = ctx;
  const cache = engine.cache;
  const all = cache.inspect().map(({ key, entry }) => ({ key, entry, ...splitCacheKey(key) }));
  const shown = all.filter((e) => matches(e.path, filter)).sort((a, b) => b.entry.size - a.entry.size);
  const entryJson = (e: { entry: CacheEntry; path: string; args: string; shared: boolean }) =>
    e.entry.kind === "waiting"
      ? {
          path: e.path,
          argsDigest: argsDigest(e.args),
          shared: e.shared,
          state: "running",
          size: e.entry.size,
          ts: e.entry.ts,
        }
      : {
          path: e.path,
          argsDigest: argsDigest(e.args),
          shared: e.shared,
          state: "ready",
          size: e.entry.size,
          originalTs: Number(e.entry.result.originalTs),
          tokenTs: Number(e.entry.result.tokenTs),
          observedTime: e.entry.result.observedTime,
          readSet: readSetJson(ctx, e.entry.result.reads),
        };
  return {
    entries: cache.size,
    bytes: cache.bytes,
    maxBytes: cache.maxBytes,
    hits: engine.stats.cacheHits,
    misses: engine.stats.cacheMisses,
    missReasons: { ...cache.misses },
    waits: engine.stats.cacheWaits,
    evictions: cache.evictions,
    matching: shown.length,
    biggest: shown.slice(0, limit).map(entryJson),
  };
}

async function invalidations(ctx: Ctx, url: URL, req: Request): Promise<Response> {
  const q = url.searchParams;
  const raw = q.get("cursor");
  const cursor = raw === null ? 0 : Number(raw);
  if (!Number.isInteger(cursor) || cursor < 0)
    return jsonResponse({ code: "BadQueryArgs", message: "cursor: not a non-negative integer" }, 400);
  const t = q.get("timeoutMs");
  const timeoutMs = t === null ? FOLLOW_MAX_MS : Math.max(0, Math.min(FOLLOW_MAX_MS, Number(t) || 0));
  const filter = q.get("path");
  const { entries, newCursor } = await ctx.sync.inspector.after(cursor, timeoutMs, req.signal);
  const shown = entries
    .map((e: FeedRecord) => ({ e, ...splitExecKey(e.execKey) }))
    .filter((x) => matches(x.path, filter))
    .map(({ e, path, args }) => ({ path, argsDigest: argsDigest(args), ...historyJson(ctx, e.record) }));
  return jsonResponse({ entries: shown, newCursor });
}

/** The inspector's routes; `null` when `url` is none of them. Throws the caller's access error. */
export async function debugRoute(ctx: Ctx, url: URL, req: Request, caller: Caller): Promise<Response | null> {
  const m = DEBUG_ROUTE.exec(url.pathname);
  if (!m || req.method !== "GET") return null;
  ctx.functions.requireOperation(caller, "ViewMetrics");
  if (m[1] === "subscriptions") return jsonResponse(subscriptions(ctx, url));
  if (m[1] === "query_cache") return jsonResponse(queryCache(ctx, url));
  return invalidations(ctx, url, req);
}
