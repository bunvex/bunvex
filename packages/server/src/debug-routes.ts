// The subscriptions and invalidation inspector's endpoints (STUDY-131 AD-25, a bunvex addition: Convex exposes
// no read set, and says nowhere why a query ran again). Admin only, with ViewMetrics, read-only:
//
// - `GET /api/debug/subscriptions[?path=]`: per sync session and live query, its function, an args digest,
//   the ts it is at, whether its last result came from another run (`cached`), what it read (documents, bytes,
//   and the read set as index ranges with their bounds read back to values), and the last invalidations or
//   reruns of its execution (`history`, newest first);
// - `GET /api/debug/query_cache[?path=&limit=]`: the HTTP query cache's counters (misses by reason), and its
//   biggest entries with their read sets;
// - `GET /api/debug/index_cache`: the index cache's counters (STUDY-136): hits, misses by reason, evictions,
//   verified hits and mismatches, its size and budget; `{ enabled: false }` when the engine has none;
// - `GET /api/debug/invalidations?cursor=[&path=&timeoutMs=]`: invalidations after `cursor`, as a long poll
//   (the log streams' style) for a screen that follows them.
//
// Everything is decoded here, when asked; the sync hub only keeps bytes (sync-inspector.ts).
import {
  type AuditLogEvent,
  boundText,
  type CacheEntry,
  type Caller,
  describeBound,
  type Engine,
  type Interval,
  insertAuditLogEvents,
  type KeyBound,
  type KeyValue,
} from "@bunvex/core";
import { fromJsonValue, type JSONValue, toJsonValue, type Value } from "@bunvex/values";
import { auditActor, auditEvents } from "./audit-log.ts";
import { type Functions, registryKey } from "./functions.ts";
import { checkedRoomEvent, roomDefNamed } from "./rooms/ctx.ts";
import { MEMBERS_PAGE_MAX, type RoomKey } from "./rooms/hub.ts";
import { canonicalJson } from "./rooms/session.ts";
import type { Execution, SyncHub } from "./sync.ts";
import { argsDigest, type FeedRecord, type HistoryRecord } from "./sync-inspector.ts";
import type { TopologyReporter } from "./topology.ts";

export const DEBUG_ROUTE = /^\/api\/debug\/(subscriptions|query_cache|index_cache|invalidations)$/;
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

function writtenKeyJson(ctx: Ctx, index: string, key: Uint8Array) {
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

function indexCache(ctx: Ctx) {
  const cache = ctx.engine.indexCache;
  if (!cache) return { enabled: false };
  const s = cache.stats;
  return {
    enabled: true,
    entries: cache.entries,
    bytes: cache.bytes,
    maxBytes: cache.maxBytes,
    verifyPercent: cache.verifyPercent,
    hits: s.hits,
    misses: s.misses.new + s.misses.stale,
    missReasons: { ...s.misses },
    evictions: s.evictions,
    verified: s.verified,
    mismatches: s.mismatches,
  };
}

/** The inspector's routes; `null` when `url` is none of them. Throws the caller's access error. */
export async function debugRoute(ctx: Ctx, url: URL, req: Request, caller: Caller): Promise<Response | null> {
  const m = DEBUG_ROUTE.exec(url.pathname);
  if (!m || req.method !== "GET") return null;
  ctx.functions.requireOperation(caller, "ViewMetrics");
  if (m[1] === "subscriptions") return jsonResponse(subscriptions(ctx, url));
  if (m[1] === "query_cache") return jsonResponse(queryCache(ctx, url));
  if (m[1] === "index_cache") return jsonResponse(indexCache(ctx));
  return invalidations(ctx, url, req);
}

// ---------------------------------------------------------------- the topology (STUDY-131 §11, AD-04)
// `GET /api/debug/topology`: the deployment's topology, as the dashboard's Topology screen draws it (the
// contract's `Topology`): this process as the leader, alone, with its connections, subscriptions, query cache,
// commits per second and a minute of samples, and the store with its driver and lease. Admin only, with
// ViewMetrics, as the inspector's routes; read from counters the server keeps (topology.ts), no store read.

export const TOPOLOGY_ROUTE = "/api/debug/topology";

/** The topology route; `null` when `url` is not it. Throws the caller's access error. */
export function topologyRoute(
  ctx: { functions: Functions; topology: TopologyReporter },
  url: URL,
  req: Request,
  caller: Caller,
): Response | null {
  if (url.pathname !== TOPOLOGY_ROUTE || req.method !== "GET") return null;
  ctx.functions.requireOperation(caller, "ViewMetrics");
  return jsonResponse(ctx.topology.snapshot());
}

// ---------------------------------------------------------------- the rooms (AD-43, STUDY-165)
// `GET /api/debug/rooms`: the open rooms and scopes; `GET /api/debug/rooms/members`: one room's members, a page at
// a time (`?key=` from the list, or `?kind=&name=&args=`; `cursor`, `numItems` up to 100); `GET
// /api/debug/rooms/definitions`: the deployed rooms and scopes with their validators; `GET
// /api/debug/rooms/events?key=&cursor=[&timeoutMs=]`: the room's event tap, a long poll from a cursor as the
// invalidations feed (no cursor starts the tap and answers its seq at once). Admin only, with ViewMetrics, as the
// topology; read from the hub's memory, no store read.
//
// The dashboard's actions (STUDY-165 §3.4), POST with a JSON body, with WriteData (the dashboard's data writes'
// operation, which a read-only key lacks), each one done recorded in the audit log as the admin key's member:
// `/api/debug/rooms/broadcast {key, event, data}` sends a test event from the server (`from: null`), checked as
// `ctx.rooms.broadcast` checks it (400 in its words; 404 `RoomNotOpen` when the room is not open, nothing sent);
// `/remove {key, memberId}` ends a member at once (`{removed: {connections} | null}`); `/close {key}` removes every
// member (`{closed: {members, connections} | null}`). Their clients are sent RoomLeft `removed`.

export const ROOMS_ROUTE = /^\/api\/debug\/rooms(?:\/(members|definitions|events))?$/;
export const ROOMS_ACTION_ROUTE = /^\/api\/debug\/rooms\/(broadcast|remove|close)$/;
const ROOM_KINDS = new Set(["room", "presence"]);

const badRequest = (message: string) => jsonResponse({ code: "BadRequest", message }, 400);

const NOT_A_KEY = "`key` is not a room key from the list.";

/** A room key from the list (`kind|name|args`), or why it is none. */
function parseRoomKey(key: string): RoomKey | string {
  const i = key.indexOf("|");
  const j = key.indexOf("|", i + 1);
  const kind = key.slice(0, i);
  if (i < 0 || j < 0 || !ROOM_KINDS.has(kind)) return NOT_A_KEY;
  return { kind: kind as RoomKey["kind"], name: key.slice(i + 1, j), argsJson: key.slice(j + 1) };
}

/** The room a members request names, or why it names none. */
function roomKeyOf(params: URLSearchParams): RoomKey | string {
  const key = params.get("key");
  if (key !== null) return parseRoomKey(key);
  const kind = params.get("kind");
  if (kind === null || !ROOM_KINDS.has(kind)) return "`kind` must be `room` or `presence` (or pass `key`).";
  const name = params.get("name");
  if (!name) return "`name` is required (or pass `key`).";
  let args: JSONValue = {};
  const raw = params.get("args");
  if (raw !== null)
    try {
      args = JSON.parse(raw) as JSONValue;
    } catch {
      return "`args` is not valid JSON.";
    }
  // The same name and args spelling as a client's join, so one room whichever way it is written.
  return { kind: kind as RoomKey["kind"], name: registryKey(name), argsJson: canonicalJson(args) };
}

/** The rooms routes; `null` when `url` is none of them. Throws the caller's access error. */
export async function roomsRoute(
  ctx: { engine: Engine; functions: Functions; sync: SyncHub },
  url: URL,
  req: Request,
  caller: Caller,
): Promise<Response | null> {
  const action = ROOMS_ACTION_ROUTE.exec(url.pathname);
  if (action && req.method === "POST") return roomAction(ctx, action[1] as RoomAction, req, caller);
  const m = ROOMS_ROUTE.exec(url.pathname);
  if (!m || req.method !== "GET") return null;
  ctx.functions.requireOperation(caller, "ViewMetrics");
  const hub = ctx.sync.rooms.hub;
  if (m[1] === undefined) return jsonResponse({ rooms: hub.list() });
  if (m[1] === "definitions") return jsonResponse({ definitions: roomDefinitions(ctx.functions) });
  const key = roomKeyOf(url.searchParams);
  if (typeof key === "string") return badRequest(key);
  if (m[1] === "events") {
    const raw = url.searchParams.get("cursor");
    const cursor = raw === null || raw === "" ? null : Number(raw);
    if (cursor !== null && (!Number.isInteger(cursor) || cursor < 0))
      return badRequest("`cursor` must be a non-negative integer.");
    const t = url.searchParams.get("timeoutMs");
    const timeoutMs = t === null ? FOLLOW_MAX_MS : Math.max(0, Math.min(FOLLOW_MAX_MS, Number(t) || 0));
    return jsonResponse(await hub.tapEvents(key, cursor, timeoutMs, req.signal));
  }
  const rawCount = url.searchParams.get("numItems");
  const numItems = rawCount === null ? MEMBERS_PAGE_MAX : Number(rawCount);
  if (!Number.isInteger(numItems) || numItems < 1) return badRequest("`numItems` must be a positive integer.");
  return jsonResponse(hub.membersPage(key, url.searchParams.get("cursor"), Math.min(numItems, MEMBERS_PAGE_MAX)));
}

type RoomAction = "broadcast" | "remove" | "close";

/**
 * Records one dashboard action in the audit log, as the caller (the admin key's member). The action has already
 * happened in memory and cannot be undone: a failed write is logged and the action's answer still given, since an
 * error would invite a retry that sends the event, or ends a member who rejoined, a second time.
 */
async function recordAction(engine: Engine, caller: Caller, e: AuditLogEvent) {
  try {
    await engine.mutation((db) => insertAuditLogEvents(db, [e], auditActor(caller)), "_system/rooms_action");
  } catch (err) {
    console.error(`bunvex: recording the audit event ${e.action} failed:`, err);
  }
}

/** The dashboard's actions on a room (AD-43): WriteData, then the body, then the act, then its audit event. */
async function roomAction(
  ctx: { engine: Engine; functions: Functions; sync: SyncHub },
  action: RoomAction,
  req: Request,
  caller: Caller,
): Promise<Response> {
  ctx.functions.requireOperation(caller, "WriteData");
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return badRequest("The body is not valid JSON.");
  }
  if (body === null || typeof body !== "object" || Array.isArray(body))
    return badRequest("The body must be an object.");
  if (typeof body.key !== "string") return badRequest(NOT_A_KEY);
  const key = parseRoomKey(body.key);
  if (typeof key === "string") return badRequest(key);
  const hub = ctx.sync.rooms.hub;
  if (action === "broadcast") {
    if (typeof body.event !== "string") return badRequest("`event` must be a string.");
    let wire: JSONValue;
    try {
      // the room's checks first, in the words `ctx.rooms.broadcast` throws to app code
      if (key.kind !== "room") roomDefNamed(ctx.functions, key.name, "room");
      const def = roomDefNamed(ctx.functions, key.name, key.kind);
      wire = checkedRoomEvent(ctx.functions, def, body.event, fromJsonValue((body.data ?? null) as JSONValue));
    } catch (e) {
      return badRequest((e as Error).message.trimEnd());
    }
    if (!hub.isOpen(body.key)) return jsonResponse({ code: "RoomNotOpen", message: "The room is not open." }, 404);
    hub.broadcast(key, body.event, wire);
    await recordAction(ctx.engine, caller, auditEvents.broadcastRoomEvent(key.name, key.argsJson, body.event));
    return jsonResponse({});
  }
  if (action === "remove") {
    if (typeof body.memberId !== "string") return badRequest("`memberId` must be a string.");
    const removed = hub.removeMember(key, body.memberId);
    if (removed)
      await recordAction(
        ctx.engine,
        caller,
        auditEvents.removeRoomMember(key.name, key.argsJson, body.memberId, removed.connections),
      );
    return jsonResponse({ removed });
  }
  const closed = hub.closeRoom(key);
  if (closed)
    await recordAction(
      ctx.engine,
      caller,
      auditEvents.closeRoom(key.name, key.argsJson, closed.members, closed.connections),
    );
  return jsonResponse({ closed });
}

/** The deployed rooms and scopes by name, with their validators as the function metadata gives them. */
function roomDefinitions(functions: Functions) {
  return [...functions.rooms]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, d]) => {
      const base = {
        kind: d.kind,
        name,
        module: `${name.slice(0, name.lastIndexOf(":"))}.js`,
        args: d.args?.json ?? null,
      };
      if (d.kind === "presence") return { ...base, state: d.state.json, events: [] };
      return {
        ...base,
        presence: d.presence.json,
        events: Object.entries(d.events).map(([event, v]) => ({ name: event, payload: v.json })),
      };
    });
}
