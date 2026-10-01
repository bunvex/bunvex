// The sync protocol v1 (STUDY-23), after Convex's sync worker (crates/sync/src/worker.rs, state.rs):
//
// - Each connection has a `SyncSession` with its own state version `{querySet, ts, identity}`. Every
//   change reaches the client in a `Transition` from one version to the next, and all the queries a
//   transition carries are results at ONE timestamp, so a client never sees two queries disagree.
// - A transition is computed when the query set or the identity changes, after each of the connection's
//   mutations and actions, and when a commit wrote into what one of its queries read. At most one
//   transition is computed per connection at a time; triggers that arrive meanwhile coalesce into the next.
// - Query runs are shared (STUDY-23 P3): every connection that needs the same query (path, args, journal,
//   identity) at the same ts awaits one execution, and a result stays valid at a later ts while no commit
//   wrote into its reads (Convex's `extend_validity`). Per connection, only the frame is assembled.
// - The connection's mutations run one at a time, in order; its actions run concurrently.
import { type Engine, type Interval, type LogEntry, OccError, overlaps, stringifyValue } from "@bunvex/core";
import { v1 } from "@bunvex/protocol";
import type { ServerWebSocket } from "bun";
import { isSystemError, withRequestId } from "./errors.ts";
import type { Functions } from "./functions.ts";
import { collectLogs, type WithLogLines } from "./logs.ts";

/** Mutations one connection may have queued or running (Convex's OPERATION_QUEUE_BUFFER_SIZE). */
export const MAX_PENDING_MUTATIONS = 1000;
/** Actions one connection may have running (the same buffer size in Convex). */
export const MAX_INFLIGHT_ACTIONS = 1000;
/** The server sends a `Ping` after this long without sending anything (Convex's HEARTBEAT_INTERVAL). */
export const HEARTBEAT_INTERVAL_MS = 15_000;
const HEARTBEAT_CHECK_MS = 1_000;
/** Close codes (RFC 6455): 1011 for an internal error, 1013 "try again later" for OCC and overload. */
const CLOSE_INTERNAL_ERROR = 1011;
const CLOSE_TRY_AGAIN_LATER = 1013;

/** Identity is part of every execution key (STUDY-23 P10); until auth lands the only identity is none. */
const NO_IDENTITY = "none";

export type SyncDeps = {
  engine: Engine;
  functions: Functions;
  redact: boolean;
  /** A failed function run, for a client: its message (without request id) and the app's data as JSON. */
  formatError: (e: unknown) => { error: string; data?: string };
  /** Arguments in JSON form → values. */
  fromWire: (args: unknown) => unknown;
};

/** One query run at one snapshot, ready to splice into frames. */
type Execution = {
  ts: number;
  reads: Interval[];
  /** The journal the run ended with, serialized as it travels (null: none). */
  journal: string | null;
  /** The modification's fields after `queryId`, as JSON text: value or error, log lines, journal. */
  fields: string;
  type: "QueryUpdated" | "QueryFailed";
  /** What the client has seen when its hash is equal: the result and its log lines (Convex's `hash_result`). */
  hash: string;
};

type SessionQuery = {
  udfPath: string;
  args: v1.JSONValue[];
  argsJson: string;
  journal: string | null;
  key: string;
  /** The last result sent to the client, its hash, and the ts up to which it is known to be valid. */
  exec: Execution | null;
  hash: string | null;
  validAt: number;
};

/**
 * A function path as Convex canonicalizes it (`canonicalize` in crates/sync_types/src/path.rs): the module
 * without its `.js` extension, and `default` when no export is named.
 */
export function canonicalizeUdfPath(path: string): string {
  const i = path.lastIndexOf(":");
  const [module, name] = i === -1 ? [path, "default"] : [path.slice(0, i), path.slice(i + 1)];
  return `${module.endsWith(".js") ? module.slice(0, -3) : module}:${name}`;
}

const serializeJournal = (endCursor: string | null | undefined) =>
  endCursor == null ? null : JSON.stringify({ endCursor });
function parseJournal(journal: string | null): { endCursor?: string | null } {
  if (journal === null) return {};
  try {
    const j = JSON.parse(journal) as { endCursor?: unknown };
    return typeof j?.endCursor === "string" ? { endCursor: j.endCursor } : {};
  } catch {
    return {};
  }
}

/** Query executions shared by all connections, and which connections watch which key. */
export class SyncHub {
  /** The newest execution of each watched key. */
  private latest = new Map<string, Execution>();
  /** Executions running, by `ts` + key: the single flight. */
  private inflight = new Map<string, Promise<Execution>>();
  private watchers = new Map<string, Set<SyncSession>>();
  readonly sessions = new Set<SyncSession>();
  stats = { executions: 0, reused: 0, transitions: 0 };

  /** Sends each idle session its `Ping`; one timer for all sessions, not one re-armed per frame. */
  private heartbeat: ReturnType<typeof setInterval>;

  constructor(readonly deps: SyncDeps) {
    deps.engine.committer.onCommit((entries) => this.onCommit(entries));
    this.heartbeat = setInterval(() => {
      const now = performance.now();
      for (const s of this.sessions) s.pingIfIdle(now);
    }, HEARTBEAT_CHECK_MS);
    this.heartbeat.unref?.();
  }

  stop() {
    clearInterval(this.heartbeat);
  }

  private onCommit(entries: LogEntry[]) {
    for (const [key, sessions] of this.watchers) {
      const e = this.latest.get(key);
      if (!e || !entries.some((c) => overlaps(c.writes, e.reads))) continue;
      for (const s of sessions) s.schedule();
    }
  }

  /**
   * `e` is also the result under `key`: a paginated query's run returns the journal it ended with, and a
   * run with that journal at the same ts gives the same page (Convex's QueryJournal). Its reads are what
   * the key's watchers are notified by.
   */
  adopt(key: string, e: Execution) {
    const cur = this.latest.get(key);
    if (this.watchers.has(key) && (!cur || cur.ts <= e.ts)) this.latest.set(key, e);
  }

  watch(key: string, s: SyncSession) {
    const set = this.watchers.get(key);
    if (set) set.add(s);
    else this.watchers.set(key, new Set([s]));
  }

  unwatch(key: string, s: SyncSession) {
    const set = this.watchers.get(key);
    if (!set?.delete(s) || set.size > 0) return;
    this.watchers.delete(key);
    this.latest.delete(key);
  }

  /** A result of `q` valid at `ts`: the latest one when no commit between the two changed its reads. */
  resultAt(q: SessionQuery, ts: number): Promise<Execution> {
    const committer = this.deps.engine.committer;
    const l = this.latest.get(q.key);
    if (l && !committer.changedBetween(l.reads, Math.min(l.ts, ts), Math.max(l.ts, ts))) {
      this.stats.reused++;
      return Promise.resolve(l);
    }
    const flight = `${ts}\u0000${q.key}`;
    let p = this.inflight.get(flight);
    if (!p) {
      p = this.execute(q, ts).then((e) => {
        this.inflight.delete(flight);
        this.adopt(q.key, e);
        return e;
      });
      this.inflight.set(flight, p);
    }
    return p;
  }

  private async execute(q: SessionQuery, ts: number): Promise<Execution> {
    this.stats.executions++;
    const { engine, functions, fromWire } = this.deps;
    const r = await collectLogs(async () => {
      const body = functions.queryBody(q.udfPath, fromWire(q.args));
      return engine.queryTracked(body, parseJournal(q.journal), ts);
    });
    // A query that cannot start (unknown function, bad arguments) read nothing and fails at the ts.
    const run = r.ok ? r.value : { ok: false as const, error: r.error, reads: [], ts, journal: {} };
    const journal = r.ok ? serializeJournal(run.journal.endCursor) : q.journal;
    const lines = this.deps.redact ? "[]" : JSON.stringify(r.logLines);
    const tail = `,"logLines":${lines},"journal":${JSON.stringify(journal)}`;
    if (run.ok) {
      const value = stringifyValue(run.value);
      return {
        ts: run.ts,
        reads: run.reads,
        journal,
        type: "QueryUpdated",
        fields: `,"value":${value}${tail}`,
        hash: `v${value}\u0000${lines}`,
      };
    }
    const f = this.deps.formatError(run.error);
    const data = f.data === undefined ? "" : `,"errorData":${f.data}`;
    return {
      ts: run.ts,
      reads: run.reads,
      journal,
      type: "QueryFailed",
      fields: `,"errorMessage":${JSON.stringify(withRequestId(f.error))}${tail}${data}`,
      hash: `e${f.data ?? ""}\u0000${f.error}\u0000${lines}`,
    };
  }
}

type Socket = ServerWebSocket<{ session: SyncSession }>;

/** One connection's sync state and its message handling. */
export class SyncSession {
  sessionId: string | null = null;
  /** The versions the client has asked for; `version` is the last one sent in a transition. */
  private received = { querySet: 0, identity: 0 };
  private version: v1.StateVersion = { querySet: 0, ts: 0n, identity: 0 };
  private queries = new Map<number, SessionQuery>();
  private pending: (v1.AddQuery | v1.RemoveQuery)[] = [];
  private identityChanged = false;
  private scheduled = false;
  private updating = false;
  private closed = false;
  private clientClockSkew: number | null = null;
  private mutations: Promise<void> = Promise.resolve();
  private pendingMutations = 0;
  private inflightActions = 0;
  private lastSent = performance.now();
  private ws: Socket | null = null;
  /** The execution keys this session watches (those of its queries), and whether they may have changed. */
  private watching = new Set<string>();
  private keysChanged = false;
  /** `version` as JSON: the next transition's `startVersion`. */
  private versionText = versionJson(this.version);

  constructor(private hub: SyncHub) {}

  open(ws: Socket) {
    this.ws = ws;
    this.hub.sessions.add(this);
  }

  close() {
    this.closed = true;
    for (const k of this.watching) this.hub.unwatch(k, this);
    this.watching.clear();
    this.queries.clear();
    this.hub.sessions.delete(this);
  }

  private send(frame: string) {
    if (this.closed || !this.ws) return;
    this.ws.send(frame);
    this.lastSent = performance.now();
  }

  pingIfIdle(now: number) {
    if (now - this.lastSent >= HEARTBEAT_INTERVAL_MS) this.send(PING);
  }

  /** End the connection. A client error is reported in a `FatalError` first, which the client does not retry. */
  private fail(how: { fatal: string } | { code: number; reason: string }) {
    if (this.closed) return;
    if ("fatal" in how) {
      this.send(v1.encodeServerMessage({ type: "FatalError", error: how.fatal }));
      this.ws?.close();
    } else this.ws?.close(how.code, how.reason.slice(0, 123));
    this.close();
  }

  private internalError(e: unknown) {
    console.error("bunvex sync:", e);
    this.fail({ code: CLOSE_INTERNAL_ERROR, reason: "InternalServerError" });
  }

  message(frame: string) {
    let m: v1.ClientMessage;
    try {
      m = v1.parseClientMessage(frame);
    } catch (e) {
      return this.fail({ fatal: (e as Error).message });
    }
    switch (m.type) {
      case "Connect": {
        this.sessionId = m.sessionId;
        if (m.clientTs > 0) this.clientClockSkew = m.clientTs - Date.now();
        const latest = wireTs(this.hub.deps.engine.committer.visibleTs);
        // A client that saw a later ts talked to a backend with writes this one does not have.
        if (m.maxObservedTimestamp !== undefined && m.maxObservedTimestamp > latest)
          return this.internalError(
            new Error(
              `Client has observed a timestamp ${m.maxObservedTimestamp} ahead of the backend latest known timestamp ${latest}`,
            ),
          );
        return;
      }
      case "ModifyQuerySet":
        if (m.baseVersion !== this.received.querySet)
          return this.fail({
            fatal: `Base version ${m.baseVersion} passed up doesn't match the current version ${this.received.querySet}`,
          });
        if (m.newVersion <= m.baseVersion)
          return this.internalError(new Error(`query set version ${m.newVersion} does not follow ${m.baseVersion}`));
        this.pending.push(...m.modifications);
        this.received.querySet = m.newVersion;
        return this.schedule();
      case "Mutation":
        return this.mutation(m);
      case "Action":
        return this.action(m);
      case "Authenticate":
        if (m.baseVersion !== this.received.identity)
          return this.internalError(
            new Error(`identity base version ${m.baseVersion} does not match ${this.received.identity}`),
          );
        // Until @bunvex/auth verifies tokens, only "no identity" is accepted (STUDY-23 P9).
        if (m.tokenType !== "None") {
          this.send(
            v1.encodeServerMessage({
              type: "AuthError",
              error: "Authentication tokens are not supported by this server yet",
              baseVersion: this.received.identity,
              authUpdateAttempted: true,
            }),
          );
          this.ws?.close();
          return this.close();
        }
        this.received.identity++;
        this.identityChanged = true;
        return this.schedule();
      case "Event":
        return; // client telemetry (STUDY-23 P11)
    }
  }

  /** Ask for a transition; it starts now, or after the one being computed. */
  schedule() {
    this.scheduled = true;
    if (!this.updating && !this.closed) void this.update();
  }

  private async update() {
    this.updating = true;
    try {
      while (this.scheduled && !this.closed) {
        this.scheduled = false;
        await this.transition();
      }
    } catch (e) {
      this.internalError(e);
    } finally {
      this.updating = false;
    }
  }

  private async transition() {
    const { engine } = this.hub.deps;
    const modifications = new Map<number, string>();
    const querySet = this.received.querySet;
    const identity = this.received.identity;
    if (this.identityChanged) {
      // A new identity may change every result: all queries run again (Convex does the same).
      this.identityChanged = false;
      for (const q of this.queries.values()) q.exec = null;
    }
    if (this.pending.length > 0) this.keysChanged = true;
    for (const m of this.pending.splice(0)) {
      if (m.type === "Add") {
        if (this.queries.has(m.queryId)) throw new Error(`Duplicate query ID: ${m.queryId}`);
        const q: SessionQuery = {
          udfPath: canonicalizeUdfPath(m.udfPath),
          args: m.args,
          argsJson: this.canonicalArgs(m.args),
          journal: m.journal ?? null,
          key: "",
          exec: null,
          hash: null,
          validAt: 0,
        };
        q.key = keyOf(q);
        this.queries.set(m.queryId, q);
      } else {
        if (!this.queries.delete(m.queryId)) throw new Error(`Nonexistent query ID: ${m.queryId}`);
        modifications.set(m.queryId, `{"type":"QueryRemoved","queryId":${m.queryId}}`);
      }
    }
    // Watch the new keys before running, so a commit during the run is not missed.
    if (this.keysChanged) this.watchKeys();

    const ts = engine.committer.visibleTs;
    const stale = [...this.queries].filter(
      ([, q]) => !q.exec || engine.committer.changedBetween(q.exec.reads, q.validAt, ts),
    );
    const results = await Promise.all(stale.map(([, q]) => this.hub.resultAt(q, ts)));
    if (this.closed) return;
    stale.forEach(([id, q], i) => {
      const e = results[i];
      q.exec = e;
      if (e.journal !== q.journal) {
        q.journal = e.journal;
        q.key = keyOf(q);
        this.keysChanged = true;
        if (!this.watching.has(q.key)) {
          this.watching.add(q.key);
          this.hub.watch(q.key, this);
        }
        this.hub.adopt(q.key, e);
      }
      if (e.hash !== q.hash) {
        q.hash = e.hash;
        modifications.set(id, `{"type":${JSON.stringify(e.type)},"queryId":${id}${e.fields}}`);
      }
    });
    for (const q of this.queries.values()) q.validAt = ts;
    if (this.keysChanged) this.watchKeys();

    const end: v1.StateVersion = { querySet, ts: wireTs(ts), identity };
    const endText = versionJson(end);
    this.send(
      `{"type":"Transition","startVersion":${this.versionText},"endVersion":${endText},` +
        `"modifications":[${[...modifications.values()].join(",")}],` +
        // serverTs: the server's clock when sending, in ns (Convex's `inject_server_ts`): the client measures
        // the transit time with it and `clientClockSkew` (a null there reads as 1970 and warns on every frame).
        `"clientClockSkew":${this.clientClockSkew ?? null},"serverTs":${BigInt(Date.now()) * 1_000_000n}}`,
    );
    this.version = end;
    this.versionText = endText;
    this.hub.stats.transitions++;
    // A commit that landed while this transition ran, into what it sent: send the next one.
    const visible = engine.committer.visibleTs;
    for (const q of this.queries.values())
      if (q.exec && engine.committer.changedBetween(q.exec.reads, ts, visible)) {
        this.scheduled = true;
        break;
      }
  }

  /** Watch exactly the keys of the current queries. */
  private watchKeys() {
    const now = new Set<string>();
    for (const q of this.queries.values()) now.add(q.key);
    for (const k of this.watching) if (!now.has(k)) this.hub.unwatch(k, this);
    for (const k of now) if (!this.watching.has(k)) this.hub.watch(k, this);
    this.watching = now;
    this.keysChanged = false;
  }

  /** Arguments as canonical JSON (fields sorted), so equal arguments share executions. */
  private canonicalArgs(args: v1.JSONValue[]) {
    try {
      return stringifyValue(this.hub.deps.fromWire(args) as never);
    } catch {
      return JSON.stringify(args); // invalid: the run reports it
    }
  }

  private mutation(m: v1.MutationRequest) {
    if (this.pendingMutations >= MAX_PENDING_MUTATIONS)
      return this.fail({ code: CLOSE_TRY_AGAIN_LATER, reason: "TooManyConcurrentMutations" });
    this.pendingMutations++;
    // Queued before any await, so the queue order is the order frames arrived (STUDY-22).
    this.mutations = this.mutations.then(async () => {
      try {
        // A closed connection's queued mutations never start; the client resends what it got no answer for.
        if (this.closed) return;
        const { functions, fromWire } = this.hub.deps;
        const path = canonicalizeUdfPath(m.udfPath);
        // With a session (Connect came first), the request runs at most once: a resend after a reconnect
        // gets the recorded answer (`_session_requests`). Without one, as in Convex, it just runs.
        const session = this.sessionId;
        const r = await collectLogs(() =>
          session === null
            ? functions.runMutationWithTs(path, fromWire(m.args))
            : functions.runSessionMutation(path, fromWire(m.args), { sessionId: session, requestId: m.requestId }),
        );
        if (!r.ok && r.error instanceof OccError)
          return this.fail({ code: CLOSE_TRY_AGAIN_LATER, reason: r.error.code });
        if (!r.ok && isSystemError(r.error)) return this.internalError(r.error);
        if (r.ok && "replayed" in r.value) {
          const { result, logLines } = r.value.replayed;
          const out: WithLogLines<unknown> = { ok: true, value: undefined, logLines };
          this.send(this.response("MutationResponse", m.requestId, out, v1.encodeU64(wireTs(r.value.ts)), result));
        } else {
          const out: WithLogLines<unknown> =
            r.ok && "value" in r.value ? { ok: true, value: r.value.value, logLines: r.logLines } : r;
          this.send(
            this.response("MutationResponse", m.requestId, out, r.ok ? v1.encodeU64(wireTs(r.value.ts)) : null),
          );
        }
        this.schedule();
      } finally {
        this.pendingMutations--;
      }
    });
  }

  private action(m: v1.ActionRequest) {
    if (this.inflightActions >= MAX_INFLIGHT_ACTIONS)
      return this.fail({ code: CLOSE_TRY_AGAIN_LATER, reason: "TooManyInflightActionsForSingleClient" });
    this.inflightActions++;
    void (async () => {
      try {
        const { functions, fromWire } = this.hub.deps;
        const r = await collectLogs(() => functions.runAction(canonicalizeUdfPath(m.udfPath), fromWire(m.args)));
        if (this.closed) return;
        if (!r.ok && isSystemError(r.error)) return this.internalError(r.error);
        this.send(this.response("ActionResponse", m.requestId, r));
        this.schedule();
      } finally {
        this.inflightActions--;
      }
    })();
  }

  /** A MutationResponse / ActionResponse frame (`ts` only for a mutation: the commit's, or null on failure). */
  private response(
    type: string,
    requestId: number,
    r: WithLogLines<unknown>,
    ts?: string | null,
    /** The result already as JSON text (a replayed session request's). */
    resultJson?: string,
  ) {
    const lines = this.hub.deps.redact ? "[]" : JSON.stringify(r.logLines);
    const tsField = ts === undefined ? "" : `,"ts":${JSON.stringify(ts)}`;
    const head = `{"type":"${type}","requestId":${requestId}`;
    if (r.ok)
      return `${head},"success":true,"result":${resultJson ?? stringifyValue(r.value)}${tsField},"logLines":${lines}}`;
    const f = this.hub.deps.formatError(r.error);
    const data = f.data === undefined ? "" : `,"errorData":${f.data}`;
    return `${head},"success":false,"result":${JSON.stringify(withRequestId(f.error))}${tsField},"logLines":${lines}${data}}`;
  }
}

const keyOf = (q: SessionQuery) => `${q.udfPath}\u0000${q.argsJson}\u0000${q.journal ?? ""}\u0000${NO_IDENTITY}`;
const PING = v1.encodeServerMessage({ type: "Ping" });
/**
 * A commit ts as Convex's clients see it: wall-clock nanoseconds in a u64. bunvex counts microseconds (a JS
 * number is exact only to 2^53; STUDY-06 D9), so the wire value is × 1000: same magnitude and order as
 * Convex's, at microsecond resolution.
 */
export const wireTs = (us: number) => BigInt(us) * 1000n;
/** A wire ts back in bunvex's microseconds (rounded down: a snapshot at or before it). */
export const fromWireTs = (ns: bigint) => Number(ns / 1000n);

/** The last ts encoded: every session of a round sends the same one. */
let lastTs: [bigint, string] = [0n, v1.encodeU64(0n)];
const encodeTs = (ts: bigint) => {
  if (lastTs[0] !== ts) lastTs = [ts, v1.encodeU64(ts)];
  return lastTs[1];
};
const versionJson = (v: v1.StateVersion) =>
  `{"querySet":${v.querySet},"ts":"${encodeTs(v.ts)}","identity":${v.identity}}`;
