// A DashboardDataSource over an in-memory fixture, for development and tests (UI-01 §5.5). It keeps every
// semantic of the contract: key-based cursors that stay valid when documents are inserted, cursors bound
// to their query, aborts, `not_found` / `invalid_request`, and watchers that never fire synchronously.
// `latencyMs` and `failRate` exercise loading and error states by hand.
import {
  type CallOptions,
  type DashboardDataSource,
  DataSourceError,
  type DeploymentInfo,
  type DeploymentStats,
  type Document,
  type DocumentQuery,
  type FunctionInfo,
  type Json,
  type LogEntry,
  type LogFilter,
  type LogQuery,
  type Page,
  type TableInfo,
  type Unsubscribe,
} from "../data-source.ts";
import { createFixture, type FixtureOptions, type FixtureTable, makeExecution } from "./fixture.ts";
import { createRandom, type Random } from "./random.ts";

export type MockDataSourceOptions = FixtureOptions & {
  /** Delay before every call resolves. Default 0. */
  latencyMs?: number;
  /** Probability that a call fails with `unavailable`. Default 0. */
  failRate?: number;
  /** How often watchStats delivers. Default 1 000 ms. */
  statsIntervalMs?: number;
  /** How often new function executions are logged while someone watches logs. Default 1 000 ms. */
  logIntervalMs?: number;
};

// ------------------------------------------------------------------ ordering and cursors

/** Convex's order across types: null < number < boolean < string < array < object. */
function rank(v: Json | undefined): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return 1;
  if (typeof v === "boolean") return 2;
  if (typeof v === "string") return 3;
  return Array.isArray(v) ? 4 : 5;
}

export function compareValues(a: Json | undefined, b: Json | undefined): number {
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 0) return 0;
  if (ra === 4) {
    const x = a as Json[];
    const y = b as Json[];
    for (let i = 0; i < Math.min(x.length, y.length); i++) {
      const c = compareValues(x[i], y[i]);
      if (c !== 0) return c;
    }
    return x.length - y.length;
  }
  if (ra === 5) return compareValues(JSON.stringify(a), JSON.stringify(b));
  return (a as number | string | boolean) < (b as number | string | boolean) ? -1 : a === b ? 0 : 1;
}

/** The index key of a document: the indexed fields, then `_id` as the tiebreaker (unique). */
const keyOf = (doc: Document, fields: string[]): Json[] =>
  fields[0] === "_id" ? [doc._id] : [...fields.map((f) => doc[f] ?? null), doc._id];

const compareKeys = (a: Json[], b: Json[]) => compareValues(a, b);

function encodeCursor(query: string, key: Json[] | null): string {
  const bytes = new TextEncoder().encode(JSON.stringify({ q: query, k: key }));
  return btoa(String.fromCharCode(...bytes));
}

function decodeCursor(cursor: string, query: string): Json[] | null {
  let parsed: { q?: unknown; k?: unknown };
  try {
    const bytes = Uint8Array.from(atob(cursor), (c) => c.charCodeAt(0));
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new DataSourceError("invalid_request", "malformed cursor");
  }
  if (parsed.q !== query) throw new DataSourceError("invalid_request", "cursor belongs to another query");
  return parsed.k as Json[] | null;
}

function checkNumItems(n: number) {
  if (!Number.isInteger(n) || n < 1) throw new DataSourceError("invalid_request", `numItems must be ≥ 1: ${n}`);
}

/** One page after `after` (exclusive) of items already in order; `null` = from the start. */
function paginate<T>(
  items: T[],
  key: (item: T) => Json[],
  inOrder: (a: Json[], b: Json[]) => number,
  after: Json[] | null,
  numItems: number,
  query: string,
): Page<T> {
  const start = after === null ? 0 : items.findIndex((item) => inOrder(key(item), after) > 0);
  const from = start < 0 ? items.length : start;
  const page = items.slice(from, from + numItems);
  const isDone = from + numItems >= items.length;
  const last = page.at(-1);
  // At the end, the cursor still marks the position, so a later call sees documents appended meanwhile.
  return { page, isDone, continueCursor: encodeCursor(query, last === undefined ? after : key(last)) };
}

// ------------------------------------------------------------------ the source

export class MockDataSource implements DashboardDataSource {
  private readonly tables: Map<string, FixtureTable>;
  private readonly deployment: DeploymentInfo;
  private readonly functions: FunctionInfo[];
  private readonly logs: LogEntry[];
  private readonly rnd: Random;
  private readonly opts: Required<Pick<MockDataSourceOptions, "latencyMs" | "failRate">> & MockDataSourceOptions;
  private stats: DeploymentStats;
  private readonly logWatchers = new Set<{ filter: LogFilter; deliver: (e: LogEntry[]) => void }>();
  private logTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: MockDataSourceOptions = {}) {
    const fixture = createFixture(opts);
    this.opts = { latencyMs: 0, failRate: 0, ...opts };
    this.tables = new Map(fixture.tables.map((t) => [t.name, { ...t, documents: [...t.documents] }]));
    this.deployment = fixture.deployment;
    this.functions = fixture.functions;
    this.logs = [...fixture.logs];
    // a separate stream for everything that happens after construction (failures, live data)
    this.rnd = createRandom((opts.seed ?? 1) ^ 0x5eed);
    const docs = fixture.tables.reduce((n, t) => n + t.documents.length, 0);
    this.stats = {
      at: opts.now ?? Date.now(),
      commitTs: docs * 3,
      commitGroups: Math.round(docs / 4),
      conflicts: 12,
      retries: 12,
      cacheHits: 48_000,
      cacheMisses: 6_100,
      subscriptions: 37,
      subscriptionReruns: 9_400,
      subscriptionUpdates: 21_700,
    };
  }

  // ---------------------------------------------------------------- plumbing

  /** Simulated latency and failures; rejects with the signal's reason on abort, before or during the wait. */
  private async call<T>(signal: AbortSignal | undefined, body: () => T): Promise<T> {
    signal?.throwIfAborted();
    if (this.opts.latencyMs > 0)
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          clearTimeout(timer);
          reject(signal?.reason);
        };
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        }, this.opts.latencyMs);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    else await Promise.resolve();
    signal?.throwIfAborted();
    if (this.opts.failRate > 0 && this.rnd.chance(this.opts.failRate))
      throw new DataSourceError("unavailable", "mock: simulated failure");
    return body();
  }

  private table(name: string): FixtureTable {
    const t = this.tables.get(name);
    if (!t) throw new DataSourceError("not_found", `no table "${name}"`);
    return t;
  }

  private now = () => Date.now();

  // ---------------------------------------------------------------- deployment

  getDeployment(opts?: CallOptions): Promise<DeploymentInfo> {
    return this.call(opts?.signal, () => ({ ...this.deployment }));
  }

  getStats(opts?: CallOptions): Promise<DeploymentStats> {
    return this.call(opts?.signal, () => ({ ...this.stats }));
  }

  /** Moves the counters on, as a busy deployment would between two samples. */
  private advanceStats(): DeploymentStats {
    const s = this.stats;
    const commits = this.rnd.int(5, 60);
    const conflicts = this.rnd.chance(0.2) ? 1 : 0;
    const hits = this.rnd.int(50, 400);
    const reruns = this.rnd.int(0, 30);
    this.stats = {
      at: this.now(),
      commitTs: s.commitTs + commits,
      commitGroups: s.commitGroups + Math.ceil(commits / 4),
      conflicts: s.conflicts + conflicts,
      retries: s.retries + conflicts,
      cacheHits: s.cacheHits + hits,
      cacheMisses: s.cacheMisses + Math.round(hits / 8),
      subscriptions: Math.max(0, s.subscriptions + this.rnd.int(-2, 2)),
      subscriptionReruns: s.subscriptionReruns + reruns,
      subscriptionUpdates: s.subscriptionUpdates + reruns * 2,
    };
    return this.stats;
  }

  watchStats(onStats: (s: DeploymentStats) => void, _onError?: (e: DataSourceError) => void): Unsubscribe {
    let live = true;
    const first = setTimeout(() => live && onStats({ ...this.stats }), 0);
    const timer = setInterval(() => live && onStats({ ...this.advanceStats() }), this.opts.statsIntervalMs ?? 1000);
    return () => {
      live = false;
      clearTimeout(first);
      clearInterval(timer);
    };
  }

  // ---------------------------------------------------------------- tables and documents

  listTables(opts?: CallOptions): Promise<TableInfo[]> {
    return this.call(opts?.signal, () =>
      [...this.tables.values()].map((t) => ({
        name: t.name,
        indexes: t.indexes.map((i) => ({ ...i, fields: [...i.fields] })),
        documentCount: t.documents.length,
      })),
    );
  }

  listDocuments(q: DocumentQuery, opts?: CallOptions): Promise<Page<Document>> {
    return this.call(opts?.signal, () => {
      const t = this.table(q.table);
      const indexName = q.index ?? "by_creation_time";
      const ix = t.indexes.find((i) => i.name === indexName);
      if (!ix) throw new DataSourceError("invalid_request", `no index "${indexName}" on "${q.table}"`);
      const order = q.order ?? "desc";
      if (order !== "asc" && order !== "desc") throw new DataSourceError("invalid_request", `bad order: ${order}`);
      checkNumItems(q.numItems);
      const query = `docs\u0000${q.table}\u0000${indexName}\u0000${order}`;
      const after = q.cursor === null ? null : decodeCursor(q.cursor, query);
      const sign = order === "asc" ? 1 : -1;
      const inOrder = (a: Json[], b: Json[]) => sign * compareKeys(a, b);
      const key = (d: Document) => keyOf(d, ix.fields);
      const sorted = [...t.documents].sort((a, b) => inOrder(key(a), key(b)));
      return paginate(sorted, key, inOrder, after, q.numItems, query);
    });
  }

  getDocument(table: string, id: string, opts?: CallOptions): Promise<Document | null> {
    return this.call(opts?.signal, () => {
      const doc = this.table(table).documents.find((d) => d._id === id);
      return doc ? structuredClone(doc) : null;
    });
  }

  /** Not part of the contract: adds a document, as a client mutation would. Returns it. */
  insertDocument(table: string, fields: Record<string, Json>): Document {
    const t = this.table(table);
    const last = t.documents.reduce((m, d) => Math.max(m, d._creationTime), 0);
    const doc: Document = { ...fields, _id: this.rnd.id(), _creationTime: Math.max(this.now(), last + 0.001) };
    t.documents.push(doc);
    return doc;
  }

  // ---------------------------------------------------------------- functions

  listFunctions(opts?: CallOptions): Promise<FunctionInfo[]> {
    return this.call(opts?.signal, () => this.functions.map((f) => ({ ...f })));
  }

  // ---------------------------------------------------------------- logs

  listLogs(q: LogQuery, opts?: CallOptions): Promise<Page<LogEntry>> {
    return this.call(opts?.signal, () => {
      checkNumItems(q.numItems);
      const levels = q.levels ? [...q.levels].sort() : null;
      const query = `logs\u0000${q.function ?? ""}\u0000${levels?.join(",") ?? "*"}`;
      const after = q.cursor === null ? null : decodeCursor(q.cursor, query);
      const newestFirst = this.logs.filter((e) => matches(e, q)).reverse();
      const inOrder = (a: Json[], b: Json[]) => -compareKeys(a, b);
      return paginate(newestFirst, (e) => [e.id], inOrder, after, q.numItems, query);
    });
  }

  watchLogs(
    filter: LogFilter,
    onEntries: (e: LogEntry[]) => void,
    _onError?: (e: DataSourceError) => void,
  ): Unsubscribe {
    const watcher = { filter, deliver: onEntries };
    this.logWatchers.add(watcher);
    this.logTimer ??= setInterval(() => this.logSomething(), this.opts.logIntervalMs ?? 1000);
    return () => {
      this.logWatchers.delete(watcher);
      if (this.logWatchers.size === 0 && this.logTimer !== null) {
        clearInterval(this.logTimer);
        this.logTimer = null;
      }
    };
  }

  /** Not part of the contract: logs 1–3 new function executions now and delivers them to the watchers. */
  logSomething(): LogEntry[] {
    const fresh: LogEntry[] = [];
    for (let i = this.rnd.int(1, 3); i > 0; i--)
      fresh.push(...makeExecution(this.rnd, this.logs.length + fresh.length + 1, this.now()));
    this.logs.push(...fresh);
    for (const w of this.logWatchers) {
      const mine = fresh.filter((e) => matches(e, w.filter));
      if (mine.length > 0) w.deliver(mine);
    }
    return fresh;
  }
}

const matches = (e: LogEntry, f: LogFilter) =>
  (f.function === undefined || e.function?.path === f.function) &&
  (f.levels === undefined || f.levels.includes(e.level));
