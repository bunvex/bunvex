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
// - A commit that invalidates more than `threshold` subscriptions at once is splayed (STUDY-08 §3.5): each
//   invalidated session query is notified after a uniform random delay in [0, count × multiplier] ms, as
//   Convex's `advance_log` does. Anything else that triggers a transition (the session's own mutation, a
//   query set change) still runs at once and covers the invalidated queries too.

import { AuthenticationError, type VerifiedIdentity } from "@bunvex/auth";
import {
  type Caller,
  DatabaseTimeoutError,
  type Engine,
  firstOverlap,
  type Interval,
  LeaseLostError,
  type LogEntry,
  OccError,
  OutOfRetentionError,
  type QueryJournal,
  ReadSetIndex,
  stringifyValue,
} from "@bunvex/core";
import { v1 } from "@bunvex/protocol";
import { type Value, valueSize } from "@bunvex/values";
import type { ServerWebSocket } from "bun";
import { BadAdminKeyError } from "./admin-keys.ts";
import { FunctionPathError, isSystemError, isTryAgainError, newRequestId, withRequestId } from "./errors.ts";
import { wsRequestId } from "./function-log.ts";
import { type AdminCaller, callerOf, Functions, type SourcedCaller } from "./functions.ts";
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

/**
 * Splaying (Convex's `SUBSCRIPTION_INVALIDATION_DELAY_THRESHOLD`, crates/common/src/knobs.rs): a commit that
 * invalidates MORE subscriptions than this delays their notifications.
 */
export const SUBSCRIPTION_INVALIDATION_DELAY_THRESHOLD = 200;
/** Convex's `SUBSCRIPTION_INVALIDATION_DELAY_MULTIPLIER`: the splay window is count × this many ms. */
export const SUBSCRIPTION_INVALIDATION_DELAY_MULTIPLIER_MS = 5;

/**
 * Query reruns (STUDY-64 §1.4), as Convex's sync worker (crates/sync/src/worker.rs, crates/common/src/knobs.rs):
 * at most UPDATE_QUERY_CONCURRENCY of one connection's queries run at once; a run that fails with a transient
 * error is retried at the same ts with full-jitter backoff (SYNC_WORKER_QUERY_RETRY_*), and an update whose
 * ts left the write log's retention starts again at the newest ts (SYNC_WORKER_UPDATE_QUERIES_RETRY_*).
 */
export const UPDATE_QUERY_CONCURRENCY = 20;
export type RetryOptions = {
  /** A query run's backoff, in ms: the first, and the most. */
  query: { initialMs: number; maxMs: number };
  /** The whole update's backoff when its ts is out of retention, in ms. */
  update: { initialMs: number; maxMs: number };
  /** Uniform in [0, 1). */
  random: () => number;
  sleep: (ms: number) => Promise<void>;
};

/** The retry settings: `opts` over the environment (Convex's knob names and units) over Convex's defaults. */
export function retryOptions(opts: Partial<RetryOptions> = {}, env = process.env): RetryOptions {
  return {
    query: opts.query ?? {
      initialMs: knob(env, "SYNC_WORKER_QUERY_RETRY_INITIAL_BACKOFF_MS", 500),
      maxMs: knob(env, "SYNC_WORKER_QUERY_RETRY_MAX_BACKOFF_SECS", 600) * 1000,
    },
    update: opts.update ?? {
      initialMs: knob(env, "SYNC_WORKER_UPDATE_QUERIES_RETRY_INITIAL_BACKOFF_MS", 3000),
      maxMs: knob(env, "SYNC_WORKER_UPDATE_QUERIES_RETRY_MAX_BACKOFF_SECS", 600) * 1000,
    },
    random: opts.random ?? cryptoRandom(),
    sleep:
      opts.sleep ??
      ((ms) =>
        new Promise((r) => {
          const t = setTimeout(r, ms);
          t.unref?.();
        })),
  };
}

/** Convex's `Backoff::fail`: full jitter, `min(initial × 2^failures, max) × U[0, 1)`. */
export function backoffMs(b: { initialMs: number; maxMs: number }, failures: number, random: () => number): number {
  return Math.min(b.initialMs * 2 ** failures, b.maxMs) * random();
}

/** `fn` over `items`, at most `limit` at a time, results in order (Convex's `buffer_unordered`). */
async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  if (items.length <= limit) return Promise.all(items.map(fn));
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: limit }, worker));
  return out;
}

/** Timers the splay runs on; tests inject a fake clock. */
export type SplayTimers = {
  now(): number;
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
};
export type SplayOptions = {
  /** Splay when more subscriptions than this are invalidated by one commit. */
  threshold: number;
  /** The delay window is `count × multiplierMs` (0 turns splaying off). */
  multiplierMs: number;
  /** Uniform in [0, 1). Not `Math.random`, which is seeded inside executions (STUDY-03). */
  random: () => number;
  timers: SplayTimers;
};

const realTimers: SplayTimers = {
  now: () => performance.now(),
  set: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};
/** A uniform [0, 1) from the system's CSPRNG, drawn 1 024 at a time. */
function cryptoRandom(): () => number {
  const buf = new Uint32Array(1024);
  let i = buf.length;
  return () => {
    if (i === buf.length) {
      crypto.getRandomValues(buf);
      i = 0;
    }
    return buf[i++] / 2 ** 32;
  };
}

/** A knob from the environment, under Convex's name: a non-negative integer, or the default. */
function knob(env: Record<string, string | undefined>, name: string, def: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name}: not a non-negative integer: ${raw}`);
  return n;
}

/** The splay settings: `opts` over the environment (Convex's knob names) over Convex's defaults. */
export function splayOptions(opts: Partial<SplayOptions> = {}, env = process.env): SplayOptions {
  return {
    threshold:
      opts.threshold ??
      knob(env, "SUBSCRIPTION_INVALIDATION_DELAY_THRESHOLD", SUBSCRIPTION_INVALIDATION_DELAY_THRESHOLD),
    multiplierMs:
      opts.multiplierMs ??
      knob(env, "SUBSCRIPTION_INVALIDATION_DELAY_MULTIPLIER", SUBSCRIPTION_INVALIDATION_DELAY_MULTIPLIER_MS),
    random: opts.random ?? cryptoRandom(),
    timers: opts.timers ?? realTimers,
  };
}

/**
 * An execution key ends with whose result it is: `*` for a run that read no identity (shared by every
 * caller), `u:<identity>` for one that did (STUDY-27 §1.4, as the HTTP query cache; refines DV-12).
 */
const SHARED = "*";
const idPartOf = (caller: Caller) => `u:${caller.key}`;

export type SyncDeps = {
  engine: Engine;
  functions: Functions;
  redact: boolean;
  /** A failed function run, for a client: its message (without request id) and the app's data as JSON. */
  formatError: (e: unknown) => { error: string; data?: string };
  /** Arguments in JSON form → values. */
  /** A call's arguments from the wire (`path`: the function's, for Convex's "Invalid arguments for" error). */
  fromWire: (args: unknown, path: string) => unknown;
  /** Splaying of wide invalidations; defaults to `splayOptions()`. */
  splay?: SplayOptions;
  /** Verify a `User` token (STUDY-27): its identity, or an `AuthenticationError`. */
  verifyToken: (token: string) => Promise<VerifiedIdentity>;
  /** Query rerun retries; defaults to `retryOptions()`. */
  retry?: Partial<RetryOptions>;
  /**
   * An `Admin` token's caller (STUDY-34): the key checked, acting as `impersonating` when given; throws
   * `BadAdminKeyError` for a bad key, `HeaderParseError` for an identity that is not one. Absent: admin
   * tokens are refused.
   */
  adminCaller?: (key: string, impersonating: unknown) => Caller;
  /**
   * The subscriptions each commit invalidated, by the write that did it (its write source and table), as
   * Convex's `InvalidationEvent`s: the app metrics' `subscription_invalidations` (STUDY-58).
   */
  onInvalidations?: (events: { source: string | undefined; table: string; count: number }[]) => void;
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
  /** Whether the run read the caller's identity: then it is that caller's result alone. */
  identityObserved: boolean;
  /** The code generation it ran (STUDY-35): a run of superseded code is never reused nor adopted. */
  generation: number;
};

type SessionQuery = {
  udfPath: string;
  /** A non-root component path an admin asked for (STUDY-62 K8): bunvex has none, so the query fails. */
  component?: string;
  args: v1.JSONValue[];
  argsJson: string;
  journal: string | null;
  /** The execution key: path, args, journal, then whose result (`idPart`). */
  key: string;
  idPart: string;
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
  private inflight = new Map<
    string,
    { p: Promise<{ exec: Execution; idPart: string }>; owner: string; waiters: Set<SyncSession> }
  >();
  private watchers = new Map<string, Set<SyncSession>>();
  /** The read-set of each watched key's latest execution: what a commit is matched against (STUDY-08 D9). */
  readonly reads = new ReadSetIndex<string>();
  readonly sessions = new Set<SyncSession>();
  /** Bumped when deployed code changes (STUDY-35): runs of an older generation are not reused. */
  private generation = 0;
  readonly retry: RetryOptions;
  stats = { executions: 0, reused: 0, transitions: 0, splayed: 0, retries: 0 };
  readonly splay: SplayOptions;

  /** Sends each idle session its `Ping`; one timer for all sessions, not one re-armed per frame. */
  private heartbeat: ReturnType<typeof setInterval>;

  constructor(readonly deps: SyncDeps) {
    this.splay = deps.splay ?? splayOptions();
    deps.engine.committer.onCommit((entries) => this.onCommit(entries));
    this.retry = retryOptions(deps.retry);
    this.heartbeat = setInterval(() => {
      const now = performance.now();
      for (const s of this.sessions) s.pingIfIdle(now);
    }, HEARTBEAT_CHECK_MS);
    this.heartbeat.unref?.();
  }

  /**
   * New code is live (STUDY-35): every subscription to a function of a changed module runs again, as
   * Convex's re-run the queries whose `_modules` row a push rewrote; no run of the old code is reused.
   */
  invalidateModules(changed: Set<string>) {
    if (changed.size === 0) return;
    this.generation++;
    for (const s of this.sessions) if (s.invalidateModules(changed)) s.schedule();
  }

  stop() {
    clearInterval(this.heartbeat);
    for (const s of this.sessions) s.cancelSplay();
  }

  /**
   * Notify the sessions whose queries a commit wrote into. As Convex's `advance_log`
   * (crates/database/src/subscription.rs): a subscription is one session query, and when one pass
   * invalidates more than `threshold` of them, each is notified after a uniform random delay in
   * `[0, count × multiplierMs]` ms. A session wakes at the earliest delay among its queries, and its
   * transition then reruns every query that is stale, as Convex's sync worker does on any wake.
   */
  private onCommit(entries: LogEntry[]) {
    const hit = this.reads.matchingEntries(entries);
    if (hit.size === 0) return;
    // Session → how many of its queries this commit invalidates. A query whose splayed notification is
    // still pending is not counted again: in Convex it left the subscription map when it was invalidated.
    const touched = new Map<SyncSession, { n: number; keys: string[] }>();
    let count = 0;
    const events = this.deps.onInvalidations
      ? new Map<string, { source: string | undefined; table: string; count: number }>()
      : null;
    for (const key of hit) {
      const sessions = this.watchers.get(key);
      if (!sessions) continue;
      for (const s of sessions) {
        const n = s.newlyInvalidated(key);
        if (n === 0) continue;
        count += n;
        if (events) this.attribute(events, key, entries, n);
        const t = touched.get(s);
        if (t) {
          t.n += n;
          t.keys.push(key);
        } else touched.set(s, { n, keys: [key] });
      }
    }
    if (events && events.size > 0) this.deps.onInvalidations!([...events.values()]);
    const { threshold, multiplierMs, random } = this.splay;
    if (count <= threshold || multiplierMs === 0) {
      for (const s of touched.keys()) s.schedule();
      return;
    }
    this.stats.splayed += count;
    // Uniform over the integers 0..=window, as `rand::random_range(0..=splay_amt_millis)`.
    const window = count * multiplierMs;
    for (const [s, { n, keys }] of touched) {
      let delay = window;
      for (let i = 0; i < n; i++) delay = Math.min(delay, Math.floor(random() * (window + 1)));
      s.scheduleAfter(delay, keys);
    }
  }

  /** Count `n` invalidations of `key` against the first write that overlaps its reads, as Convex's. */
  private attribute(
    events: Map<string, { source: string | undefined; table: string; count: number }>,
    key: string,
    entries: LogEntry[],
    n: number,
  ) {
    const reads = this.latest.get(key)?.reads;
    if (!reads) return;
    for (const e of entries) {
      const w = firstOverlap(e.writes, reads);
      if (!w) continue;
      const table = this.tableOfIndex(w.index);
      if (table === undefined) return;
      const k = `${e.source ?? ""}\u0000${table}`;
      const ev = events.get(k);
      if (ev) ev.count += n;
      else events.set(k, { source: e.source, table, count: n });
      return;
    }
  }

  private indexTables: { catalog: unknown; map: Map<number, string> } | null = null;

  /** The table an index belongs to (rebuilt when the catalog changes). */
  private tableOfIndex(index: number): string | undefined {
    const catalog = this.deps.engine.catalog;
    if (this.indexTables?.catalog !== catalog) {
      const map = new Map<number, string>();
      for (const t of catalog.tables.values()) {
        for (const ix of t.indexes.values()) map.set(ix.id, t.name);
        for (const ix of t.pending) map.set(ix.id, t.name);
      }
      this.indexTables = { catalog, map };
    }
    return this.indexTables.map.get(index);
  }

  /**
   * `e` is also the result under `key`: a paginated query's run returns the journal it ended with, and a
   * run with that journal at the same ts gives the same page (Convex's QueryJournal). Its reads are what
   * the key's watchers are notified by.
   */
  adopt(key: string, e: Execution) {
    if (e.generation !== this.generation) return;
    const cur = this.latest.get(key);
    if (this.watchers.has(key) && (!cur || cur.ts <= e.ts)) {
      this.latest.set(key, e);
      this.reads.set(key, e.reads);
    }
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
    this.reads.delete(key);
  }

  /**
   * A result of `q` valid at `ts` for `caller`, and the key it lives under: the latest one (this caller's,
   * else the shared one of a run that read no identity) when no commit between the two changed its reads.
   * `session`: who waits for it (a run is retried only while someone does).
   */
  resultAt(
    q: SessionQuery,
    ts: number,
    caller: Caller,
    session?: SyncSession,
  ): Promise<{ exec: Execution; idPart: string }> {
    const committer = this.deps.engine.committer;
    const mine = idPartOf(caller);
    // Access first (STUDY-34): a caller who may not run the query (an internal or system function without
    // an admin key, an operation the key lacks) never reuses another caller's run; its own run fails, and
    // is not kept for anyone.
    try {
      this.deps.functions.checkQueryAccess(q.udfPath, caller);
    } catch {
      return this.execute(q, ts, caller, () => session?.isOpen ?? true).then((exec) => ({ exec, idPart: mine }));
    }
    const valid = (l: Execution | undefined): l is Execution =>
      l !== undefined &&
      l.generation === this.generation &&
      !committer.changedBetween(l.reads, Math.min(l.ts, ts), Math.max(l.ts, ts));
    // Where the query lives now, when that is shared or this caller's.
    if (q.idPart === SHARED || q.idPart === mine) {
      const l = this.latest.get(q.key);
      if (valid(l)) {
        this.stats.reused++;
        return Promise.resolve({ exec: l, idPart: q.idPart });
      }
      // As Convex's `stored_key_hint`: a query stored shared runs at the shared key, so other callers wait
      // for that run instead of starting their own.
      if (q.idPart === SHARED) return this.flight(q, ts, caller, q.key, session);
    }
    const base = baseKeyOf(q);
    for (const idPart of [mine, SHARED]) {
      const l = this.latest.get(`${base}\u0000${idPart}`);
      if (valid(l)) {
        this.stats.reused++;
        return Promise.resolve({ exec: l, idPart });
      }
    }
    // Otherwise runs for different callers stay apart: nobody knows before running whether the identity is read.
    const at = this.latest.has(`${base}\u0000${SHARED}`) ? SHARED : mine;
    return this.flight(q, ts, caller, `${base}\u0000${at}`, session);
  }

  /** A run of `q` at `ts` for the key `at`, joined by every caller that asks for the same one meanwhile. */
  private flight(
    q: SessionQuery,
    ts: number,
    caller: Caller,
    at: string,
    session: SyncSession | undefined,
  ): Promise<{ exec: Execution; idPart: string }> {
    const key = `${this.generation}\u0000${ts}\u0000${at}`;
    const mine = idPartOf(caller);
    let f = this.inflight.get(key);
    if (!f) {
      const base = at.slice(0, at.lastIndexOf("\u0000"));
      const waiters = new Set<SyncSession>();
      // Without a session (a caller outside the protocol), the run is always wanted.
      const wanted = () => session === undefined || [...waiters].some((s) => s.isOpen);
      const p = this.execute(q, ts, caller, wanted).then(
        (exec) => {
          this.inflight.delete(key);
          const idPart = exec.identityObserved ? mine : SHARED;
          this.adopt(`${base}\u0000${idPart}`, exec);
          return { exec, idPart };
        },
        (e) => {
          this.inflight.delete(key);
          throw e;
        },
      );
      f = { p, owner: mine, waiters };
      this.inflight.set(key, f);
    }
    if (session) f.waiters.add(session);
    if (f.owner === mine) return f.p;
    // A run that read another caller's identity is not ours: run at our own key.
    const own = `${at.slice(0, at.lastIndexOf("\u0000"))}\u0000${mine}`;
    return f.p.then((r) => (r.idPart === SHARED ? r : this.flight(q, ts, caller, own, session)));
  }

  /**
   * Run `q` at `ts`, again after a transient failure (Convex's `is_retriable_sync_worker_error`), with backoff,
   * while `wanted()`: the store timed out or lost its connection, or the lease was lost for a moment. Any
   * other failure of the server is thrown (the connection closes with 1011).
   */
  private async execute(q: SessionQuery, ts: number, caller: Caller, wanted: () => boolean): Promise<Execution> {
    for (let failures = 0; ; failures++) {
      try {
        return await this.executeOnce(q, ts, caller);
      } catch (e) {
        if (!this.isRetriable(e) || !wanted()) throw e;
        this.stats.retries++;
        console.error(`bunvex sync: a query failed; retrying (${failures + 1}):`, e);
        await this.retry.sleep(backoffMs(this.retry.query, failures, this.retry.random));
        if (!wanted()) throw e;
      }
    }
  }

  /** A transient failure: the error, or one it was caused by, is a store timeout, a lost lease, or transient to the store. */
  private isRetriable(e: unknown): boolean {
    const persistence = this.deps.engine.persistence;
    for (let x = e, depth = 0; x instanceof Error && depth < 8; x = x.cause, depth++)
      if (x instanceof DatabaseTimeoutError || x instanceof LeaseLostError || persistence.isTransient?.(x)) return true;
    return false;
  }

  private async executeOnce(q: SessionQuery, ts: number, caller: Caller): Promise<Execution> {
    this.stats.executions++;
    const generation = this.generation;
    const { engine, functions, fromWire } = this.deps;
    const r = await collectLogs(() =>
      functions.logged(
        "Query",
        q.udfPath,
        { ...caller, source: "SyncWorker" } as SourcedCaller,
        async () => {
          if (q.component !== undefined) throw componentNotFound(q.component);
          const body = functions.queryBody(q.udfPath, fromWire(q.args, q.udfPath), true, caller);
          return engine.queryTracked(body, parseJournal(q.journal), ts, caller);
        },
        (run) => (run.ok ? { returnBytes: valueSize((run.value ?? null) as Value) } : { error: run.error }),
      ),
    );
    // A system error is no result: the connection closes and the client resubscribes (Convex's sync worker
    // fails with it; STUDY-20 D8).
    if (!r.ok && isSystemError(r.error)) throw r.error;
    if (r.ok && !r.value.ok && isSystemError(r.value.error)) throw r.value.error;
    // A query that cannot start (unknown function, bad arguments) read nothing and fails at the ts.
    const run = r.ok
      ? r.value
      : { ok: false as const, error: r.error, reads: [], ts, journal: {} as QueryJournal, identityObserved: false };
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
        identityObserved: run.identityObserved,
        generation,
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
      identityObserved: run.identityObserved,
      generation,
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
  /** Who this connection acts as (STUDY-27), and when its token expires (seconds; none without a token). */
  private caller: Caller = callerOf(null);
  private expiresAt: number | undefined;
  /** Client messages are handled one at a time, in order (an `Authenticate` waits for its verification). */
  private inbox: Promise<void> = Promise.resolve();
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
  /** How many of this session's queries have each key (Convex counts one subscription per query). */
  private keyCounts = new Map<string, number>();
  /** A splayed notification: its timer, when it fires, and the keys it is for (STUDY-08 §3.5). */
  private splayTimer: unknown = null;
  private splayDue = Number.POSITIVE_INFINITY;
  private splayedKeys = new Set<string>();
  /** `version` as JSON: the next transition's `startVersion`. */
  private versionText = versionJson(this.version);

  constructor(private hub: SyncHub) {}

  /** Whether the connection is still open (a query run is retried only for an open one). */
  get isOpen(): boolean {
    return !this.closed;
  }

  open(ws: Socket) {
    this.ws = ws;
    this.hub.sessions.add(this);
  }

  close() {
    this.closed = true;
    this.cancelSplay();
    for (const k of this.watching) this.hub.unwatch(k, this);
    this.watching.clear();
    this.queries.clear();
    this.hub.sessions.delete(this);
  }

  /** Whether this client takes `TransitionChunk`s: set by the server from the client's version (DV-10). */
  transitionChunks = false;

  private sendTransition(json: string) {
    for (const frame of transitionFrames(json, this.transitionChunks)) this.send(frame);
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
    // Out of retention is Convex's `CloseCode::Again`: the client reconnects and resends the mutation.
    this.fail({
      code: isTryAgainError(e) ? CLOSE_TRY_AGAIN_LATER : CLOSE_INTERNAL_ERROR,
      reason: "InternalServerError",
    });
  }

  message(frame: string) {
    let m: v1.ClientMessage;
    try {
      m = v1.parseClientMessage(frame);
    } catch (e) {
      return this.fail({ fatal: (e as Error).message });
    }
    this.inbox = this.inbox.then(() => (this.closed ? undefined : this.handle(m))).catch((e) => this.internalError(e));
  }

  /** End the connection with an `AuthError` (Convex: the error message, the identity version, no close frame). */
  private authError(error: string, authUpdateAttempted: boolean) {
    if (this.closed) return;
    this.send(
      v1.encodeServerMessage({ type: "AuthError", error, baseVersion: this.received.identity, authUpdateAttempted }),
    );
    this.ws?.close();
    this.close();
  }

  /**
   * The caller to run as now, or null once its token has expired, which ends the connection with
   * `TokenExpired` (Convex's `SyncState::identity`, checked before every use of the identity).
   */
  /** Where the connection comes from (STUDY-44): set by the server when it upgrades the request. */
  peer: { ip: string | null; userAgent: string | null } = { ip: null, userAgent: null };
  /** The user's raw token, for `ctx.meta.getRequestMetadata()`; null for an admin key or none. */
  private token: string | null = null;

  /**
   * The current caller with the request a mutation or action runs for. Its request id is Convex's for a
   * WebSocket request (`RequestId::new_for_ws_session`), which the log stream filters by (STUDY-47); a new
   * one before Connect.
   */
  private requestCaller(counter: number): SourcedCaller | null {
    const caller = this.currentCaller();
    if (caller === null) return null;
    const requestId = this.sessionId === null ? newRequestId() : wsRequestId(this.sessionId, counter);
    return {
      ...caller,
      source: "SyncWorker",
      request: { ...this.peer, requestId, authToken: this.token, scheduledFunctionId: null },
    };
  }

  private currentCaller(): Caller | null {
    if (this.expiresAt !== undefined && Date.now() / 1000 >= this.expiresAt) {
      this.authError("Token identity expired", false);
      return null;
    }
    return this.caller;
  }

  private async handle(m: v1.ClientMessage) {
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
      case "Authenticate": {
        if (m.baseVersion !== this.received.identity)
          return this.internalError(
            new Error(`identity base version ${m.baseVersion} does not match ${this.received.identity}`),
          );
        if (m.tokenType === "Admin") {
          // Convex's `authenticate` for an admin key: a bad key is unauthenticated (`AuthError`, not an
          // update the client can retry); an acting identity that is not one ends the session.
          const make = this.hub.deps.adminCaller;
          if (!make) return this.authError("The provided admin key was invalid for this instance", false);
          try {
            this.caller = make(m.value, m.impersonating);
            this.token = null;
          } catch (e) {
            if (e instanceof BadAdminKeyError) return this.authError(e.message, false);
            return this.fail({ fatal: (e as Error).message });
          }
          this.expiresAt = undefined; // admin identities do not expire (DV-163)
        } else if (m.tokenType === "User") {
          let verified: VerifiedIdentity;
          try {
            verified = await this.hub.deps.verifyToken(m.value);
          } catch (e) {
            if (!(e instanceof AuthenticationError)) throw e;
            // Convex's AuthUpdateFailed: the client refreshes its token and reconnects.
            return this.authError(e.message, true);
          }
          this.caller = callerOf(verified.identity);
          this.token = m.value;
          this.expiresAt = verified.expiresAt;
        } else {
          this.caller = callerOf(null);
          this.token = null;
          this.expiresAt = undefined;
        }
        this.received.identity++;
        this.identityChanged = true;
        return this.schedule();
      }
      case "Event":
        return; // client telemetry (STUDY-23 P11)
    }
  }

  /**
   * How many of this session's queries on `key` a commit newly invalidates: none while a splayed
   * notification for the key is pending (Convex removed those subscriptions when it invalidated them).
   */
  newlyInvalidated(key: string): number {
    if (this.closed || this.splayedKeys.has(key)) return 0;
    return this.keyCounts.get(key) ?? 1;
  }

  /**
   * Ask for a transition in `ms`, unless one is already due sooner (Convex's delayed invalidation). `keys`
   * were invalidated; they stay pending until a transition starts.
   */
  scheduleAfter(ms: number, keys: Iterable<string>) {
    if (this.closed) return;
    for (const k of keys) this.splayedKeys.add(k);
    const { timers } = this.hub.splay;
    const due = timers.now() + ms;
    if (due >= this.splayDue) return;
    if (this.splayTimer !== null) timers.clear(this.splayTimer);
    this.splayDue = due;
    this.splayTimer = timers.set(() => {
      this.splayTimer = null;
      this.splayDue = Number.POSITIVE_INFINITY;
      this.schedule();
    }, ms);
  }

  /** Drop a pending splayed notification: a transition is starting, or the session is closing. */
  cancelSplay() {
    if (this.splayTimer !== null) this.hub.splay.timers.clear(this.splayTimer);
    this.splayTimer = null;
    this.splayDue = Number.POSITIVE_INFINITY;
    this.splayedKeys.clear();
  }

  /** Ask for a transition; it starts now, or after the one being computed. */
  /** Drop the results of queries to a changed module (they re-run); whether any was. */
  invalidateModules(changed: Set<string>): boolean {
    let any = false;
    for (const q of this.queries.values())
      if (changed.has(Functions.moduleOf(q.udfPath))) {
        q.exec = null;
        any = true;
      }
    return any;
  }

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
    const caller = this.currentCaller();
    if (caller === null) return;
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
        const component = componentOf(m.componentPath, caller);
        const q: SessionQuery = {
          ...(component === null ? {} : { component }),
          udfPath: canonicalizeUdfPath(m.udfPath),
          args: m.args,
          argsJson: this.canonicalArgs(m.args),
          journal: m.journal ?? null,
          key: "",
          idPart: SHARED,
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

    let ts: number;
    let stale: [number, SessionQuery][];
    let results: { exec: Execution; idPart: string }[];
    for (let failures = 0; ; failures++) {
      ts = engine.committer.visibleTs;
      // This transition runs every query stale at `ts`, so it covers any pending splayed notification
      // (Convex drops the invalidation futures of the queries it reruns). Same tick as reading `ts`.
      this.cancelSplay();
      const at = ts;
      stale = [...this.queries].filter(
        ([, q]) => !q.exec || engine.committer.changedBetween(q.exec.reads, q.validAt, at),
      );
      try {
        // At most UPDATE_QUERY_CONCURRENCY at a time, as Convex's `buffer_unordered` (STUDY-64 §1.4).
        results = await mapLimit(stale, UPDATE_QUERY_CONCURRENCY, ([, q]) => this.hub.resultAt(q, at, caller, this));
        break;
      } catch (e) {
        // A ts that left the write log's retention while its queries ran (or were retried): start again
        // at the newest ts, after a backoff (Convex's `update_queries` loop on `is_out_of_retention`).
        if (!(e instanceof OutOfRetentionError) || this.closed) throw e;
        const { retry } = this.hub;
        console.error(`bunvex sync: updating queries failed; retrying (${failures + 1}):`, e);
        await retry.sleep(backoffMs(retry.update, failures, retry.random));
        if (this.closed) return;
      }
    }
    if (this.closed) return;
    stale.forEach(([id, q], i) => {
      const { exec: e, idPart } = results[i];
      q.exec = e;
      if (e.journal !== q.journal || idPart !== q.idPart) {
        q.journal = e.journal;
        q.idPart = idPart;
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
    this.sendTransition(
      `{"type":"Transition","startVersion":${this.versionText},"endVersion":${endText},` +
        `"modifications":[${[...modifications.values()].join(",")}],` +
        // serverTs: the server's clock when sending, in ns (Convex's `inject_server_ts`): the client measures
        // the transit time with it and `clientClockSkew` (a null there reads as 1970 and warns on every frame).
        `"clientClockSkew":${this.clientClockSkew ?? null},"serverTs":${BigInt(Date.now()) * 1_000_000n}}`,
    );
    this.version = end;
    this.versionText = endText;
    this.hub.stats.transitions++;
    // A commit that landed while this transition ran, into what it sent: send the next one. A query this
    // transition did not rerun is still subscribed, so a splayed commit's timer covers it; one it reran is
    // subscribed anew, and Convex finds a new subscription already invalid at once (`subscribe` refreshes it
    // through the write log), so that one does not wait.
    const visible = engine.committer.visibleTs;
    const rerun = new Set(stale.map(([, q]) => q));
    for (const q of this.queries.values())
      if (
        q.exec &&
        (this.splayTimer === null || rerun.has(q)) &&
        engine.committer.changedBetween(q.exec.reads, ts, visible)
      ) {
        this.scheduled = true;
        break;
      }
  }

  /** Watch exactly the keys of the current queries. */
  private watchKeys() {
    const now = new Set<string>();
    this.keyCounts.clear();
    for (const q of this.queries.values()) {
      now.add(q.key);
      this.keyCounts.set(q.key, (this.keyCounts.get(q.key) ?? 0) + 1);
    }
    for (const k of this.watching) if (!now.has(k)) this.hub.unwatch(k, this);
    for (const k of now) if (!this.watching.has(k)) this.hub.watch(k, this);
    this.watching = now;
    this.keysChanged = false;
  }

  /** Arguments as canonical JSON (fields sorted), so equal arguments share executions. */
  private canonicalArgs(args: v1.JSONValue[]) {
    try {
      return stringifyValue(this.hub.deps.fromWire(args, "") as never);
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
        const caller = this.requestCaller(m.requestId);
        if (caller === null) return;
        let component: string | null;
        try {
          component = componentOf(m.componentPath, caller);
        } catch (e) {
          return this.internalError(e);
        }
        if (component !== null) {
          const missing = await collectLogs(async () => Promise.reject(componentNotFound(component!)));
          this.send(this.response("MutationResponse", m.requestId, missing, null));
          return;
        }
        const path = canonicalizeUdfPath(m.udfPath);
        // With a session (Connect came first), the request runs at most once: a resend after a reconnect
        // gets the recorded answer (`_session_requests`). Without one, as in Convex, it just runs.
        const session = this.sessionId;
        const r = await collectLogs(() =>
          session === null
            ? functions.runMutationWithTs(path, fromWire(m.args, path), true, caller)
            : functions.runSessionMutation(
                path,
                fromWire(m.args, path),
                { sessionId: session, requestId: m.requestId },
                caller,
              ),
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
    const caller = this.requestCaller(m.requestId);
    if (caller === null) return;
    let component: string | null;
    try {
      component = componentOf(m.componentPath, caller);
    } catch (e) {
      return this.internalError(e);
    }
    if (component !== null) {
      void collectLogs(async () => Promise.reject(componentNotFound(component!))).then((r) =>
        this.send(this.response("ActionResponse", m.requestId, r)),
      );
      return;
    }
    this.inflightActions++;
    void (async () => {
      try {
        const { functions, fromWire } = this.hub.deps;
        const r = await collectLogs(() =>
          functions.runAction(canonicalizeUdfPath(m.udfPath), fromWire(m.args, m.udfPath), caller),
        );
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

/** Path, args and journal: what a run's result depends on besides the caller. */
const baseKeyOf = (q: SessionQuery) =>
  `${q.component === undefined ? "" : `${q.component}\u0001`}${q.udfPath}\u0000${q.argsJson}\u0000${q.journal ?? ""}`;

/**
 * Convex's `parse_admin_component_path` (crates/sync/src/worker.rs, STUDY-62 K8): a function of a non-root
 * component may be called directly only by an admin (not one acting as a user) or the system; anyone else
 * ends the session (an untyped error). The component, or null for the root.
 */
function componentOf(componentPath: string | undefined, caller: Caller): string | null {
  if (componentPath === undefined || componentPath === "") return null;
  const admin = (caller as AdminCaller).admin;
  if (!admin || caller.identity != null)
    throw new Error("Only admin or system users can call functions on non-root components directly");
  return componentPath;
}

/** Convex's `ComponentPathNotFound`: bunvex has no components (STUDY-62), so every non-root path is missing. */
const componentNotFound = (path: string) => new FunctionPathError(`Component path '${path}' not found`);
const keyOf = (q: SessionQuery) => `${baseKeyOf(q)}\u0000${q.idPart}`;
const PING = v1.encodeServerMessage({ type: "Ping" });

/** Convex's MAX_MESSAGE_SIZE: a larger transition goes as chunks of this many bytes (DV-10). */
export const MAX_TRANSITION_MESSAGE_BYTES = 5_000_000;
/** Convex's MIN_NPM_VERSION_FOR_TRANSITION_CHUNKS: older clients get every transition whole. */
export const MIN_CLIENT_VERSION_FOR_TRANSITION_CHUNKS = "1.28.0";

/**
 * Whether a sync client takes `TransitionChunk`s (Convex's `new_sync_worker_config`): an npm client — its
 * version in the client header (`npm-<version>`), else in the URL (`/api/<version>/sync`) — at least 1.28.0.
 */
export function supportsTransitionChunks(clientHeader: string | null, path: string): boolean {
  let version: string | undefined;
  if (clientHeader !== null) {
    const m = /^npm-(.+)$/.exec(clientHeader);
    if (!m) return false;
    version = m[1];
  } else version = /^\/api\/([^/]+)\/sync$/.exec(path)?.[1];
  if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) return false;
  return Bun.semver.order(version, MIN_CLIENT_VERSION_FOR_TRANSITION_CHUNKS) >= 0;
}

/**
 * A transition's frames (Convex's `maybe_split_transition`): itself, or — over MAX_TRANSITION_MESSAGE_BYTES
 * for a client that takes them — its JSON cut into chunks of at most that many bytes on UTF-8 character
 * boundaries, numbered from 0, sharing an id (the JSON's length in bytes, as Convex's).
 */
export function transitionFrames(json: string, chunks: boolean): string[] {
  if (!chunks) return [json];
  const bytes = Buffer.from(json);
  if (bytes.length <= MAX_TRANSITION_MESSAGE_BYTES) return [json];
  const parts: string[] = [];
  for (let start = 0; start < bytes.length; ) {
    let end = Math.min(start + MAX_TRANSITION_MESSAGE_BYTES, bytes.length);
    // Back off continuation bytes (10xxxxxx), so a character is never split.
    while (end > start && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
    parts.push(bytes.toString("utf8", start, end));
    start = end;
  }
  const transitionId = String(bytes.length);
  return parts.map((chunk, partNumber) =>
    JSON.stringify({ type: "TransitionChunk", chunk, partNumber, totalParts: parts.length, transitionId }),
  );
}
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
