// A DashboardDataSource over an in-memory fixture, for development and tests (UI-01 §5.5, v2 in §12.4). It
// keeps every semantic of the contract: filter expressions with the index rules, key-based cursors bound
// to their query that stay valid across inserts, aborts, `not_found` / `invalid_request` naming the
// clause, watchers that never fire synchronously, writes that are all-or-nothing and gated by the
// capabilities. `latencyMs`, `failRate` and `liveWritesMs` exercise loading, errors and live data by hand.
import {
  type AuditEvent,
  type AuditEventQuery,
  type AuthConfig,
  type AuthEmailAction,
  type AuthEvent,
  type AuthOrganization,
  type AuthProvider,
  type AuthSession,
  type AuthUser,
  type AuthUserQuery,
  type CallOptions,
  type Capabilities,
  type CronJob,
  type CronRun,
  type DashboardDataSource,
  DataSourceError,
  type DeploymentInfo,
  type DeploymentState,
  type DeploymentStats,
  type Document,
  type DocumentQuery,
  type EnvironmentVariable,
  type EnvironmentVariableChange,
  type FieldPatch,
  type FileFilter,
  type FileQuery,
  type FileStats,
  type FilterExpression,
  type FunctionInfo,
  type FunctionMetric,
  type FunctionRun,
  type LogEntry,
  type LogFilter,
  type LogQuery,
  type MetricsWindow,
  OPERATIONS,
  type Page,
  type RunOptions,
  type ScheduledFunction,
  type ScheduledFunctionQuery,
  type SchemaInfo,
  type SchemaValidation,
  type SnapshotExport,
  type SnapshotImport,
  type SnapshotImportRequest,
  type StoredFile,
  type TableInfo,
  type TableMetric,
  type Timeseries,
  type TopKMeasure,
  type TopKSeries,
  type Topology,
  toDataSourceError,
  type Unsubscribe,
  type ValidatorJson,
  type Value,
} from "../data-source.ts";
import { tableNameProblem } from "../database/table-name.ts";
import { mockParts } from "../extensions/mock.ts";
import type { MockContext, MockExtensionPart } from "../extensions/mock-types.ts";
import { canonicalFilter, compareValues, fieldValue, matchesFilter, validateFilter } from "../filters.ts";
import { validateValue } from "../validators.ts";
import { MockAudit } from "./audit.ts";
import { SAMPLE_AUTH_PROVIDERS } from "./auth.ts";
import { MockAuthAdmin } from "./auth-admin.ts";
import { MockEnvironmentVariables } from "./env-vars.ts";
import { MockFiles } from "./files.ts";
import { createFixture, type FixtureOptions, type FixtureTable, makeExecution, SYSTEM_INDEXES } from "./fixture.ts";
import { MOCK_DOCUMENT_TYPES } from "./function-validators.ts";
import { inferDocumentType } from "./infer.ts";
import * as metrics from "./metrics.ts";
import { createRandom, type Random } from "./random.ts";
import { MockScheduler } from "./schedules.ts";
import { MockSnapshots } from "./snapshots.ts";
import { MockTopology } from "./topology.ts";

export type MockDataSourceOptions = FixtureOptions & {
  /** The extensions' mock parts (UI-01 §26). Default: the registry's (`src/extensions/mock.ts`). */
  extensions?: readonly MockExtensionPart[];
  /** Delay before every call resolves. Default 0. */
  latencyMs?: number;
  /** Probability that a call fails with `unavailable`. Default 0. */
  failRate?: number;
  /** How often watchStats delivers. Default 1 000 ms. */
  statsIntervalMs?: number;
  /** How often new function executions are logged while someone watches logs. Default 1 000 ms. */
  logIntervalMs?: number;
  /** When set, a task is inserted (and now and then one deleted) this often, as a live app would. */
  liveWritesMs?: number;
  /** What the caller may do. Default: every operation, not read-only. */
  capabilities?: Capabilities;
  /** Pending scheduled runs at the start. Default 24. */
  scheduled?: number;
  /** How often due scheduled runs and crons run while someone watches them. Default 1 000 ms. */
  schedulerIntervalMs?: number;
  /** Start with a few stored files (images, texts, binaries). Default true. */
  sampleFiles?: boolean;
  /** Start with a few past audit events (deploys, index builds, variables). Default true. */
  sampleAudit?: boolean;
  /** The configured authentication providers (UI-01 §19.1). Default: an OIDC one and a custom JWT one. */
  authProviders?: AuthProvider[];
  /** Between two steps of a snapshot export or import (UI-01 §19.2). Default 300 ms. */
  snapshotStepMs?: number;
  /** How many nodes the topology shows (UI-01 §22): 1 (default, as bunvex runs today) to 8. */
  nodes?: number;
  /** How often watchTopology delivers. Default 1 000 ms. */
  topologyIntervalMs?: number;
};

/** At most this many documents per insert or delete call, as a server bounds a transaction. */
export const MAX_WRITE = 4096;

// ------------------------------------------------------------------ cursors

type Key = Value[];

function encodeCursor(query: string, key: Key | null): string {
  const bytes = new TextEncoder().encode(JSON.stringify({ q: query, k: key }));
  return btoa(String.fromCharCode(...bytes));
}

function decodeCursor(cursor: string, query: string): Key | null {
  let parsed: { q?: unknown; k?: unknown };
  try {
    const bytes = Uint8Array.from(atob(cursor), (c) => c.charCodeAt(0));
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new DataSourceError("invalid_request", "malformed cursor");
  }
  if (parsed.q !== query) throw new DataSourceError("invalid_request", "cursor belongs to another query");
  return parsed.k as Key | null;
}

function checkNumItems(n: number) {
  if (!Number.isInteger(n) || n < 1) throw new DataSourceError("invalid_request", `numItems must be ≥ 1: ${n}`);
}

/** One page after `after` (exclusive) of items already in order; `null` = from the start. */
function paginate<T>(
  items: T[],
  key: (item: T) => Key,
  inOrder: (a: Key, b: Key) => number,
  after: Key | null,
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

const NEWEST_FIRST: FilterExpression = { clauses: [], order: "desc" };
const FIELD_NAME = /^[a-zA-Z][a-zA-Z0-9_]*$/;

function checkFields(fields: Record<string, unknown>, what: string) {
  for (const k of Object.keys(fields))
    if (!FIELD_NAME.test(k))
      throw new DataSourceError("invalid_request", `${what}: "${k}" is not a field name (system fields start with _)`);
}

// ------------------------------------------------------------------ the source

export class MockDataSource implements DashboardDataSource {
  private readonly tables: Map<string, FixtureTable>;
  private readonly deployment: DeploymentInfo;
  private readonly functions: FunctionInfo[];
  private readonly logs: LogEntry[];
  private readonly rnd: Random;
  private readonly opts: MockDataSourceOptions & { latencyMs: number; failRate: number; capabilities: Capabilities };
  private stats: DeploymentStats;
  private readonly logWatchers = new Set<{ filter: LogFilter; deliver: (e: LogEntry[]) => void }>();
  private logTimer: ReturnType<typeof setInterval> | null = null;
  private readonly tableWatchers = new Map<string, Set<(c: { count?: number }) => void>>();
  private liveTimer: ReturnType<typeof setInterval> | null = null;
  /** UI-01 §17.2: a paused deployment refuses new calls; its scheduler waits and skips crons. */
  private paused = false;
  /** Scheduled functions and cron jobs (UI-01 §14). Not part of the contract: tests drive it directly. */
  readonly scheduler: MockScheduler;
  /** File storage (UI-01 §14). Not part of the contract: tests read blobs from it. */
  readonly files: MockFiles;
  private readonly envVars = new MockEnvironmentVariables();
  /** The audit log (UI-01 §14.5). Not part of the contract: tests read what the writes recorded. */
  readonly audit: MockAudit;
  private readonly snapshots: MockSnapshots;
  private readonly topology: MockTopology;
  /** The app's users and their auth (UI-01 §25). Not part of the contract: tests read it. */
  readonly authAdmin: MockAuthAdmin;

  constructor(opts: MockDataSourceOptions = {}) {
    const fixture = createFixture(opts);
    this.opts = {
      latencyMs: 0,
      failRate: 0,
      capabilities: { operations: [...OPERATIONS], readOnly: false },
      ...opts,
    };
    this.tables = new Map(fixture.tables.map((t) => [t.name, { ...t, documents: [...t.documents] }]));
    this.deployment = fixture.deployment;
    this.functions = fixture.functions;
    this.logs = [...fixture.logs];
    // a separate stream for everything that happens after construction (failures, live data)
    this.rnd = createRandom((opts.seed ?? 1) ^ 0x5eed);
    this.scheduler = new MockScheduler(
      {
        rnd: this.rnd,
        functions: this.functions,
        paused: () => this.paused,
        run: (fn, time) => {
          const lines = makeExecution(this.rnd, this.logs.length + 1, time, {
            fn,
            error: this.rnd.chance(0.1) ? "timeout" : undefined,
          });
          this.log(lines);
          const end = lines.at(-1)?.execution;
          const failed = end?.status === "failure";
          return {
            failed,
            durationMs: end?.durationMs ?? 0,
            lines: lines.map((l) => l.message),
            ...(failed && { error: lines.at(-1)!.message }),
          };
        },
        paginate: (items, key, q, query) => {
          checkNumItems(q.numItems);
          const after = q.cursor === null ? null : decodeCursor(q.cursor, query);
          return paginate(items, key, compareValues, after, q.numItems, query);
        },
      },
      opts.now ?? Date.now(),
      opts.scheduled ?? 24,
    );
    this.files = new MockFiles(
      {
        rnd: this.rnd,
        paginate: (items, key, q, query) => {
          checkNumItems(q.numItems);
          const after = q.cursor === null ? null : decodeCursor(q.cursor, query);
          return paginate(items, key, compareValues, after, q.numItems, query);
        },
      },
      opts.now ?? Date.now(),
      opts.sampleFiles ?? true,
    );
    this.audit = new MockAudit(
      {
        rnd: this.rnd,
        paginate: (items, key, q, query) => {
          checkNumItems(q.numItems);
          const after = q.cursor === null ? null : decodeCursor(q.cursor, query);
          return paginate(items, key, compareValues, after, q.numItems, query);
        },
      },
      opts.now ?? Date.now(),
      opts.sampleAudit ?? true,
    );
    this.snapshots = new MockSnapshots({
      tables: this.tables,
      files: this.files,
      rnd: this.rnd,
      now: () => this.scheduler.now(),
      record: (action, metadata) => this.record(action, metadata),
      changed: (table) => this.changed(table),
      stepMs: opts.snapshotStepMs ?? 300,
    });
    this.authAdmin = new MockAuthAdmin(opts.seed ?? 1, () => this.scheduler.now());
    this.topology = new MockTopology(this.rnd, {
      nodes: opts.nodes ?? 1,
      now: opts.now ?? Date.now(),
      version: this.deployment.version,
      persistence: this.deployment.persistence,
    });
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
    // each extension's part (UI-01 §26) adds its methods, sharing the mock's clock, knobs, credentials, audit
    const ctx: MockContext = {
      rnd: this.rnd,
      now: () => this.scheduler.now(),
      call: (signal, fn) => this.call(signal, fn),
      can: (op) => {
        const c = this.opts.capabilities;
        return op === "write" ? !c.readOnly && c.operations.includes("writeData") : c.operations.includes(op);
      },
      record: (action, metadata) => this.record(action, metadata as Parameters<MockAudit["record"]>[1]),
      options: opts as Record<string, unknown>,
    };
    for (const part of opts.extensions ?? mockParts) Object.assign(this, part.create(ctx));
  }

  // ---------------------------------------------------------------- plumbing

  /** Simulated latency and failures; rejects with the signal's reason on abort, before or during the wait. */
  private async call<T>(signal: AbortSignal | undefined, body: () => T | Promise<T>): Promise<T> {
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

  private canWrite() {
    const c = this.opts.capabilities;
    if (c.readOnly || !c.operations.includes("writeData"))
      throw new DataSourceError("unauthorized", "this credential cannot write data");
  }

  /** Tells the table's watchers, later (never inside the caller's stack). */
  private changed(table: string) {
    const watchers = this.tableWatchers.get(table);
    if (!watchers?.size) return;
    const count = this.tables.get(table)?.documents.length;
    setTimeout(() => {
      for (const w of watchers) w({ count });
    }, 0);
  }

  private now = () => Date.now();

  // ---------------------------------------------------------------- deployment

  // pausing (UI-01 §17.2, data-source-state.ts)
  getDeploymentState(opts?: CallOptions): Promise<DeploymentState> {
    return this.call(opts?.signal, () => ({ state: this.paused ? "paused" : "running" }));
  }

  pauseDeployment(opts?: CallOptions): Promise<void> {
    return this.call(opts?.signal, () => this.setPaused(true, "pauseDeployment"));
  }

  resumeDeployment(opts?: CallOptions): Promise<void> {
    return this.call(opts?.signal, () => this.setPaused(false, "resumeDeployment"));
  }

  private setPaused(paused: boolean, op: "pauseDeployment" | "resumeDeployment") {
    const c = this.opts.capabilities;
    if (c.readOnly || !c.operations.includes(op))
      throw new DataSourceError("unauthorized", `this credential cannot ${paused ? "pause" : "resume"} the deployment`);
    if (this.paused === paused) return;
    this.paused = paused;
    // Convex's deployment events
    this.record(paused ? "pause_deployment" : "unpause_deployment", {});
  }

  getDeployment(opts?: CallOptions): Promise<DeploymentInfo> {
    return this.call(opts?.signal, () => ({ ...this.deployment }));
  }

  getCapabilities(opts?: CallOptions): Promise<Capabilities> {
    return this.call(opts?.signal, () => structuredClone(this.opts.capabilities));
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

  // ---------------------------------------------------------------- tables, schema, documents

  listTables(opts?: CallOptions): Promise<TableInfo[]> {
    return this.call(opts?.signal, () =>
      [...this.tables.values()].map((t) => ({
        name: t.name,
        indexes: structuredClone(t.indexes),
        documentCount: t.documents.length,
        declared: t.declared,
      })),
    );
  }

  /**
   * As if a new schema had been pushed (STUDY-12 §14.7): it is checked against the stored documents over
   * `durationMs`, then accepted (`pass`), or rejected with the documents that do not match (`fail`). The dev
   * host's `?validate=pass|fail` starts one.
   */
  simulateSchemaValidation(outcome: "pass" | "fail", durationMs = 20_000) {
    this.schemaValidation = { start: this.scheduler.now(), durationMs, outcome };
  }
  private schemaValidation?: { start: number; durationMs: number; outcome: "pass" | "fail" };

  private validationNow(): SchemaValidation | undefined {
    const v = this.schemaValidation;
    if (!v) return undefined;
    const declared = [...this.tables.values()].filter((t) => t.declared);
    const total = declared.reduce((n, t) => n + t.documents.length, 0);
    const done = Math.min(1, (this.scheduler.now() - v.start) / v.durationMs);
    if (done < 1)
      return {
        state: "validating",
        numDocsValidated: Math.floor(total * done),
        // the total is known after the first moment, as a server counts while it walks
        totalDocs: done < 0.1 ? null : total,
      };
    if (v.outcome === "pass") {
      this.schemaValidation = undefined;
      return undefined;
    }
    const table = declared.find((t) => t.documents.length > 0);
    const bad = (table?.documents ?? []).slice(0, 3);
    return {
      state: "failed",
      failedDocs: Math.max(bad.length, Math.floor(total * 0.004)),
      sample: bad.map((d) => ({
        table: table!.name,
        id: d._id as string,
        error: "Object is missing the required field `owner`.",
      })),
    };
  }

  getSchema(opts?: CallOptions): Promise<SchemaInfo> {
    return this.call(opts?.signal, () => ({
      ...(this.validationNow() && { validation: this.validationNow() }),
      enforced: false,
      tables: [...this.tables.values()]
        .filter((t) => t.declared)
        .map((t) => {
          const validator = MOCK_DOCUMENT_TYPES[t.name];
          return validator ? { name: t.name, validator: structuredClone(validator) } : { name: t.name };
        }),
    }));
  }

  listDocuments(q: DocumentQuery, opts?: CallOptions): Promise<Page<Document>> {
    return this.call(opts?.signal, () => {
      const t = this.table(q.table);
      checkNumItems(q.numItems);
      const expr = q.filter ?? NEWEST_FIRST;
      const ix = validateFilter(expr, t.indexes);
      const fields = ix.name === "by_id" ? ["_id"] : ix.fields;
      // the index key: its fields, then _id (unique, the tiebreaker) — except by_id, which is _id alone
      const key = (d: Document): Key =>
        ix.name === "by_id" ? [d._id] : [...fields.map((f) => fieldValue(d, f) ?? null), d._id];
      const sign = expr.order === "asc" ? 1 : -1;
      const inOrder = (a: Key, b: Key) => sign * compareValues(a, b);
      const query = canonicalFilter(q.table, q.filter);
      const after = q.cursor === null ? null : decodeCursor(q.cursor, query);
      // each document's key once (not per comparison), and only the page is cloned: at 100 000 documents a
      // page went from ~230 ms to a fraction of it in the browser (UI-01 §19.3)
      const matching = t.documents
        .filter((d) => matchesFilter(d, expr, ix))
        .map((d) => ({ d, k: key(d) }))
        .sort((a, b) => inOrder(a.k, b.k));
      const page = paginate(matching, (m) => m.k, inOrder, after, q.numItems, query);
      return { ...page, page: page.page.map((m) => structuredClone(m.d)) };
    });
  }

  getDocument(table: string, id: string, opts?: CallOptions): Promise<Document | null> {
    return this.call(opts?.signal, () => {
      const doc = this.table(table).documents.find((d) => d._id === id);
      return doc ? structuredClone(doc) : null;
    });
  }

  inferDocumentType(table: string, opts?: CallOptions): Promise<ValidatorJson | null> {
    return this.call(opts?.signal, () => {
      const t = this.table(table);
      const owner = new Map<string, string>();
      for (const other of this.tables.values()) for (const d of other.documents) owner.set(d._id, other.name);
      return inferDocumentType(t.documents, (id) => owner.get(id) ?? null);
    });
  }

  tableOfId(id: string, opts?: CallOptions): Promise<string | null> {
    return this.call(opts?.signal, () => {
      for (const t of this.tables.values()) if (t.documents.some((d) => d._id === id)) return t.name;
      return null;
    });
  }

  watchTable(table: string, onChange: (c: { count?: number }) => void, onError: (e: DataSourceError) => void) {
    let live = true;
    const deliver = (c: { count?: number }) => live && onChange(c);
    if (!this.tables.has(table)) {
      setTimeout(() => live && onError(new DataSourceError("not_found", `no table "${table}"`)), 0);
      return () => {
        live = false;
      };
    }
    const set = this.tableWatchers.get(table) ?? new Set();
    this.tableWatchers.set(table, set);
    set.add(deliver);
    if (this.opts.liveWritesMs) this.liveTimer ??= setInterval(() => this.liveWrite(), this.opts.liveWritesMs);
    return () => {
      live = false;
      set.delete(deliver);
      const anyone = [...this.tableWatchers.values()].some((s) => s.size > 0);
      if (!anyone && this.liveTimer !== null) {
        clearInterval(this.liveTimer);
        this.liveTimer = null;
      }
    };
  }

  /** What `liveWritesMs` does: a new task most of the time, sometimes a deleted one. */
  private liveWrite() {
    if (this.paused) return; // no function runs while paused
    const tasks = this.tables.get("tasks");
    const users = this.tables.get("users");
    if (!tasks || !users) return;
    if (this.rnd.chance(0.2) && tasks.documents.length > 0) {
      tasks.documents.splice(this.rnd.int(0, tasks.documents.length - 1), 1);
    } else {
      const last = tasks.documents.reduce((m, d) => Math.max(m, d._creationTime), 0);
      tasks.documents.push({
        _id: this.rnd.id(),
        _creationTime: Math.max(this.now(), last + 0.001),
        text: this.rnd.pick(["Review the new index", "Answer the issue", "Measure the fan-out", "Ship the fix"]),
        done: false,
        owner: this.rnd.pick(users.documents)._id,
        priority: this.rnd.int(1, 5),
        tags: [],
      });
    }
    this.changed("tasks");
  }

  // ---------------------------------------------------------------- writes

  createTable(name: string, opts?: CallOptions): Promise<void> {
    return this.call(opts?.signal, () => {
      this.canWrite();
      const invalid = tableNameProblem(name);
      if (invalid) throw new DataSourceError("invalid_request", invalid);
      if (this.tables.has(name)) throw new DataSourceError("invalid_request", `Table "${name}" already exists.`);
      this.tables.set(name, { name, indexes: structuredClone(SYSTEM_INDEXES), documents: [], declared: false });
    });
  }

  insertDocuments(table: string, documents: Record<string, Value>[], opts?: CallOptions): Promise<string[]> {
    return this.call(opts?.signal, () => {
      this.canWrite();
      const t = this.table(table);
      if (documents.length > MAX_WRITE)
        throw new DataSourceError("invalid_request", `at most ${MAX_WRITE} documents per insert`);
      // validate everything first: all or nothing
      for (const [i, d] of documents.entries()) checkFields(d, `document ${i + 1}`);
      let last = t.documents.reduce((m, d) => Math.max(m, d._creationTime), 0);
      const docs = documents.map((fields) => {
        last = Math.max(this.now(), last + 0.001);
        return { ...structuredClone(fields), _id: this.rnd.id(), _creationTime: last } as Document;
      });
      t.documents.push(...docs);
      this.changed(table);
      this.record("add_documents", { table, count: docs.length });
      return docs.map((d) => d._id);
    });
  }

  /** Not part of the contract: one document, synchronously — for tests that need a known state. */
  insertDocument(table: string, fields: Record<string, Value>): Document {
    const t = this.table(table);
    const last = t.documents.reduce((m, d) => Math.max(m, d._creationTime), 0);
    const doc: Document = { ...fields, _id: this.rnd.id(), _creationTime: Math.max(this.now(), last + 0.001) };
    t.documents.push(doc);
    this.changed(table);
    return doc;
  }

  patchDocuments(table: string, ids: string[], fields: Record<string, FieldPatch>, opts?: CallOptions) {
    return this.call(opts?.signal, () => {
      this.canWrite();
      const t = this.table(table);
      checkFields(fields, "patch");
      const docs = ids.map((id) => {
        const d = t.documents.find((x) => x._id === id);
        if (!d) throw new DataSourceError("not_found", `no document ${id} in "${table}"`);
        return d;
      });
      for (const d of docs)
        for (const [k, v] of Object.entries(fields)) {
          const isUnset = typeof v === "object" && v !== null && !Array.isArray(v) && "$unset" in v;
          if (isUnset) delete d[k];
          else d[k] = structuredClone(v as Value);
        }
      this.changed(table);
      this.record("update_documents", { table, count: docs.length });
    });
  }

  replaceDocument(table: string, id: string, document: Record<string, Value>, opts?: CallOptions) {
    return this.call(opts?.signal, () => {
      this.canWrite();
      const t = this.table(table);
      checkFields(document, "replace");
      const i = t.documents.findIndex((x) => x._id === id);
      if (i < 0) throw new DataSourceError("not_found", `no document ${id} in "${table}"`);
      const old = t.documents[i]!;
      t.documents[i] = { ...structuredClone(document), _id: old._id, _creationTime: old._creationTime };
      this.changed(table);
      this.record("update_documents", { table, count: 1 });
    });
  }

  deleteDocuments(table: string, ids: string[], opts?: CallOptions) {
    return this.call(opts?.signal, () => {
      this.canWrite();
      const t = this.table(table);
      if (ids.length > MAX_WRITE) throw new DataSourceError("invalid_request", `at most ${MAX_WRITE} deletes per call`);
      const gone = new Set(ids);
      const before = t.documents.length;
      t.documents = t.documents.filter((d) => !gone.has(d._id));
      this.changed(table);
      if (t.documents.length < before) this.record("delete_documents", { table, count: before - t.documents.length });
    });
  }

  clearTable(table: string, opts?: CallOptions) {
    return this.call(opts?.signal, () => {
      this.canWrite();
      const t = this.table(table);
      const deleted = t.documents.length;
      t.documents = [];
      this.changed(table);
      this.record("clear_tables", { tables: [table], count: deleted });
      return { deleted };
    });
  }

  // ---------------------------------------------------------------- functions

  listFunctions(opts?: CallOptions): Promise<FunctionInfo[]> {
    return this.call(opts?.signal, () => this.functions.map((f) => structuredClone(f)));
  }

  // ---------------------------------------------------------------- logs

  listLogs(q: LogQuery, opts?: CallOptions): Promise<Page<LogEntry>> {
    return this.call(opts?.signal, () => {
      checkNumItems(q.numItems);
      const levels = q.levels ? [...q.levels].sort() : null;
      const query = `logs\u0000${q.function ?? ""}\u0000${levels?.join(",") ?? "*"}`;
      const after = q.cursor === null ? null : decodeCursor(q.cursor, query);
      const newestFirst = this.logs.filter((e) => logMatches(e, q)).reverse();
      const inOrder = (a: Key, b: Key) => -compareValues(a, b);
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
    this.log(fresh);
    return fresh;
  }

  private log(fresh: LogEntry[]) {
    this.logs.push(...fresh);
    for (const w of this.logWatchers) {
      const mine = fresh.filter((e) => logMatches(e, w.filter));
      if (mine.length > 0) w.deliver(mine);
    }
  }

  // ---------------------------------------------------------------- running functions

  /**
   * Runs a mock function: `<table>:list` returns the table's newest documents (`limit`, default 10),
   * `<table>:get` the document `id` (or null), `tasks:byOwner` the tasks of `owner`; everything else returns
   * null, and nothing changes data. Mock only: `throw: "message"` in the arguments makes it throw.
   */
  runFunction(path: string, args: Record<string, Value>, opts?: RunOptions): Promise<FunctionRun> {
    return this.call(opts?.signal, () => {
      const fn = this.functions.find((f) => f.path === path);
      if (!fn) throw new DataSourceError("not_found", `no function "${path}"`);
      const c = this.opts.capabilities;
      if (!c.operations.includes("runFunctions"))
        throw new DataSourceError("unauthorized", "this credential cannot run functions");
      if (c.readOnly && fn.kind !== "query")
        throw new DataSourceError("unauthorized", `a read-only credential cannot run a ${fn.kind}`);
      const identity = opts?.identity;
      if (identity && !c.operations.includes("actAsUser"))
        throw new DataSourceError("unauthorized", "this credential cannot act as a user");
      if (this.paused)
        throw new DataSourceError(
          "invalid_request",
          "This deployment is paused: new function calls fail until it is resumed (Settings → General).",
        );
      // arguments that do not fit the declared validator fail the call, as a server's validation does
      const invalid = fn.args ? validateValue(fn.args, args)[0] : undefined;
      const error = invalid
        ? `ArgumentValidationError: ${invalid.message}`
        : typeof args.throw === "string"
          ? `Uncaught Error: ${args.throw}`
          : undefined;
      const lines = makeExecution(this.rnd, this.logs.length + 1, this.now(), { fn, error, identity });
      this.log(lines);
      const run: FunctionRun = {
        logLines: lines.map((l) => ({ level: l.level, message: l.message })),
        durationMs: lines.at(-1)?.execution?.durationMs ?? 0,
      };
      if (error !== undefined) run.error = { message: error };
      else run.value = this.mockValue(path, args);
      return run;
    });
  }

  watchFunction(
    path: string,
    args: Record<string, Value>,
    onResult: (run: FunctionRun) => void,
    onError: (error: DataSourceError) => void,
    opts?: Pick<RunOptions, "identity">,
  ): Unsubscribe {
    let live = true;
    const fail = (e: unknown) => live && onError(toDataSourceError(e));
    const fn = this.functions.find((f) => f.path === path);
    if (fn && fn.kind !== "query") {
      setTimeout(
        () => fail(new DataSourceError("invalid_request", `${path} is a ${fn.kind}: only a query is watched`)),
        0,
      );
      return () => {
        live = false;
      };
    }
    // a query reads its module's table (tasks:list reads tasks): it runs again when that table changes
    const rerun = () => {
      if (live) this.runFunction(path, args, opts).then((r) => live && onResult(r), fail);
    };
    rerun();
    const table = path.split(":")[0]!;
    const off = this.tables.has(table) ? this.watchTable(table, rerun, () => {}) : () => {};
    return () => {
      live = false;
      off();
    };
  }

  private mockValue(path: string, args: Record<string, Value>): Value {
    const [module, name] = path.split(":") as [string, string];
    const docs = this.tables.get(module)?.documents;
    if (!docs) return null;
    const newest = () => [...docs].sort((a, b) => b._creationTime - a._creationTime);
    const copy = (d: Document) => structuredClone(d) as Value;
    if (name === "list")
      return newest()
        .slice(0, typeof args.limit === "number" ? args.limit : 10)
        .map(copy);
    if (name === "get") {
      const d = docs.find((x) => x._id === args.id);
      return d ? copy(d) : null;
    }
    if (name === "byOwner")
      return newest()
        .filter((d) => d.owner === args.owner)
        .map(copy);
    return null;
  }

  // ---------------------------------------------------------------- scheduled functions and crons (§14)

  listScheduledFunctions(q: ScheduledFunctionQuery, opts?: CallOptions): Promise<Page<ScheduledFunction>> {
    return this.call(opts?.signal, () => this.scheduler.list(q));
  }

  watchScheduledFunctions(onChange: () => void, _onError?: (e: DataSourceError) => void): Unsubscribe {
    return this.scheduler.watch(onChange, this.opts.schedulerIntervalMs ?? 1000);
  }

  cancelScheduledFunction(id: string, opts?: CallOptions): Promise<void> {
    return this.call(opts?.signal, () => {
      this.canWrite();
      const fn = this.scheduler.list({ numItems: 100_000, cursor: null }).page.find((j) => j.id === id)?.function;
      this.scheduler.cancel(id);
      this.record("cancel_scheduled_function", { id, function: fn ?? null });
    });
  }

  cancelAllScheduledFunctions(fn?: string, opts?: CallOptions): Promise<{ canceled: number }> {
    return this.call(opts?.signal, () => {
      this.canWrite();
      const r = this.scheduler.cancelAll(fn);
      if (r.canceled > 0) this.record("cancel_all_scheduled_functions", { function: fn ?? null, count: r.canceled });
      return r;
    });
  }

  listCronJobs(opts?: CallOptions): Promise<CronJob[]> {
    return this.call(opts?.signal, () => this.scheduler.cronJobs());
  }

  listCronRuns(name: string, opts?: CallOptions): Promise<CronRun[]> {
    return this.call(opts?.signal, () => this.scheduler.cronRuns(name));
  }

  // ---------------------------------------------------------------- file storage (§14)

  listFiles(q: FileQuery, opts?: CallOptions): Promise<Page<StoredFile>> {
    return this.call(opts?.signal, () => this.files.list(q));
  }

  countFiles(opts?: CallOptions): Promise<number> {
    return this.call(opts?.signal, () => this.files.count());
  }

  fileStats(filter?: FileFilter, opts?: CallOptions): Promise<FileStats> {
    return this.call(opts?.signal, () => this.files.stats(filter));
  }

  getFile(id: string, opts?: CallOptions): Promise<StoredFile | null> {
    return this.call(opts?.signal, () => this.files.get(id));
  }

  uploadFile(file: Blob, opts?: CallOptions): Promise<string> {
    return this.call(opts?.signal, async () => {
      this.canWrite();
      const id = await this.files.upload(file, this.scheduler.now());
      this.record("generate_upload_url", { storage_id: id, size: file.size });
      return id;
    });
  }

  deleteFiles(ids: string[], opts?: CallOptions): Promise<void> {
    return this.call(opts?.signal, async () => {
      this.canWrite();
      const before = await this.files.count();
      await this.files.delete(ids);
      const deleted = before - (await this.files.count());
      if (deleted > 0) this.record("delete_files", { count: deleted });
    });
  }

  watchFiles(onChange: () => void, _onError?: (e: DataSourceError) => void): Unsubscribe {
    return this.files.watch(onChange);
  }

  // ---------------------------------------------------------------- environment variables (§14)

  private can(op: "viewEnvironmentVariables" | "writeEnvironmentVariables") {
    const c = this.opts.capabilities;
    if (!c.operations.includes(op) || (op === "writeEnvironmentVariables" && c.readOnly))
      throw new DataSourceError(
        "unauthorized",
        `this credential cannot ${op === "viewEnvironmentVariables" ? "view" : "change"} environment variables`,
      );
  }

  listEnvironmentVariables(opts?: CallOptions): Promise<EnvironmentVariable[]> {
    return this.call(opts?.signal, () => {
      this.can("viewEnvironmentVariables");
      return this.envVars.list();
    });
  }

  updateEnvironmentVariables(changes: EnvironmentVariableChange[], opts?: CallOptions): Promise<void> {
    return this.call(opts?.signal, () => {
      this.can("writeEnvironmentVariables");
      const had = new Set(this.envVars.list().map((v) => v.name));
      this.envVars.update(changes);
      for (const c of changes) {
        if (c.value === null && !had.has(c.name)) continue;
        const action = c.value === null ? "delete" : had.has(c.name) ? "update" : "create";
        this.record(`${action}_environment_variable`, { variable_name: c.name });
      }
    });
  }

  // ---------------------------------------------------------------- authentication (§19.1)

  // ---------------------------------------------------------------- the app's users (UI-01 §25)
  private canViewAuth() {
    if (!this.opts.capabilities.operations.includes("viewData"))
      throw new DataSourceError("unauthorized", "this credential cannot view the app's users");
  }
  private viewAuth<T>(signal: AbortSignal | undefined, body: () => T): Promise<T> {
    return this.call(signal, () => {
      this.canViewAuth();
      return body();
    });
  }
  private writeAuth<T>(signal: AbortSignal | undefined, body: () => T): Promise<T> {
    return this.call(signal, () => {
      this.canWrite();
      return body();
    });
  }

  listAuthUsers(q: AuthUserQuery, opts?: CallOptions): Promise<Page<AuthUser>> {
    return this.viewAuth(opts?.signal, () => this.authAdmin.list(q));
  }
  getAuthUser(id: string, opts?: CallOptions): Promise<AuthUser | null> {
    return this.viewAuth(opts?.signal, () => this.authAdmin.get(id));
  }
  createAuthUser(input: { name: string; email: string; password?: string }, opts?: CallOptions): Promise<string> {
    return this.writeAuth(opts?.signal, () => this.authAdmin.create(input));
  }
  inviteAuthUser(email: string, opts?: CallOptions): Promise<void> {
    return this.writeAuth(opts?.signal, () => this.authAdmin.invite(email));
  }
  sendAuthEmail(userId: string, kind: AuthEmailAction, opts?: CallOptions): Promise<void> {
    return this.writeAuth(opts?.signal, () => this.authAdmin.sendEmail(userId, kind));
  }
  listAuthSessions(q: { userId?: string }, opts?: CallOptions): Promise<AuthSession[]> {
    return this.viewAuth(opts?.signal, () => this.authAdmin.listSessions(q.userId));
  }
  revokeAuthSession(id: string, opts?: CallOptions): Promise<void> {
    return this.writeAuth(opts?.signal, () => this.authAdmin.revokeSession(id));
  }
  revokeAuthUserSessions(userId: string, opts?: CallOptions): Promise<number> {
    return this.writeAuth(opts?.signal, () => this.authAdmin.revokeUserSessions(userId));
  }
  removeAuthUserFactors(userId: string, opts?: CallOptions): Promise<void> {
    return this.writeAuth(opts?.signal, () => this.authAdmin.removeFactors(userId));
  }
  banAuthUser(userId: string, ban: { reason?: string; expiresInSeconds?: number }, opts?: CallOptions): Promise<void> {
    return this.writeAuth(opts?.signal, () => this.authAdmin.ban(userId, ban));
  }
  unbanAuthUser(userId: string, opts?: CallOptions): Promise<void> {
    return this.writeAuth(opts?.signal, () => this.authAdmin.unban(userId));
  }
  impersonateAuthUser(userId: string, opts?: CallOptions): Promise<string> {
    return this.writeAuth(opts?.signal, () => this.authAdmin.impersonate(userId));
  }
  removeAuthUser(userId: string, opts?: CallOptions): Promise<void> {
    return this.writeAuth(opts?.signal, () => this.authAdmin.remove(userId));
  }
  listAuthOrganizations(opts?: CallOptions): Promise<AuthOrganization[]> {
    return this.viewAuth(opts?.signal, () => this.authAdmin.organizations());
  }
  getAuthConfig(opts?: CallOptions): Promise<AuthConfig> {
    return this.viewAuth(opts?.signal, () => this.authAdmin.getConfig());
  }
  updateAuthConfig(patch: Partial<AuthConfig>, opts?: CallOptions): Promise<AuthConfig> {
    return this.writeAuth(opts?.signal, () => this.authAdmin.updateConfig(patch));
  }
  listAuthEvents(q: { userId?: string; limit?: number }, opts?: CallOptions): Promise<AuthEvent[]> {
    return this.viewAuth(opts?.signal, () => this.authAdmin.listEvents(q));
  }

  listAuthProviders(opts?: CallOptions): Promise<AuthProvider[]> {
    return this.call(opts?.signal, () => {
      const ops = this.opts.capabilities.operations;
      if (!ops.includes("viewData") || !ops.includes("viewEnvironmentVariables"))
        throw new DataSourceError("unauthorized", "this credential cannot view the authentication configuration");
      return structuredClone(this.opts.authProviders ?? SAMPLE_AUTH_PROVIDERS);
    });
  }

  // ---------------------------------------------------------------- snapshots (§19.2)

  private canBackups(op: "viewBackups" | "createBackups" | "downloadBackups" | "importBackups") {
    const c = this.opts.capabilities;
    if (!c.operations.includes(op))
      throw new DataSourceError(
        "unauthorized",
        `this credential cannot ${
          { viewBackups: "view", createBackups: "request", downloadBackups: "download", importBackups: "import" }[op]
        } snapshots`,
      );
    if (op === "importBackups") this.canWrite();
  }

  getLatestSnapshotExport(opts?: CallOptions): Promise<SnapshotExport | null> {
    return this.call(opts?.signal, () => {
      this.canBackups("viewBackups");
      return this.snapshots.latestExport();
    });
  }

  requestSnapshotExport(options: { includeStorage: boolean }, opts?: CallOptions): Promise<SnapshotExport> {
    return this.call(opts?.signal, () => {
      this.canBackups("createBackups");
      return this.snapshots.requestExport(!!options?.includeStorage);
    });
  }

  downloadSnapshotExport(id: string, opts?: CallOptions): Promise<Blob> {
    return this.call(opts?.signal, () => {
      this.canBackups("downloadBackups");
      return this.snapshots.download(id);
    });
  }

  startSnapshotImport(request: SnapshotImportRequest, opts?: CallOptions): Promise<SnapshotImport> {
    return this.call(opts?.signal, () => {
      this.canBackups("importBackups");
      return this.snapshots.start(request);
    });
  }

  confirmSnapshotImport(id: string, opts?: CallOptions): Promise<void> {
    return this.call(opts?.signal, () => {
      this.canBackups("importBackups");
      this.snapshots.confirm(id);
    });
  }

  cancelSnapshotImport(id: string, opts?: CallOptions): Promise<void> {
    return this.call(opts?.signal, () => {
      this.canBackups("importBackups");
      this.snapshots.cancel(id);
    });
  }

  getSnapshotImport(id: string, opts?: CallOptions): Promise<SnapshotImport> {
    return this.call(opts?.signal, () => {
      this.canBackups("viewBackups");
      return this.snapshots.getImport(id);
    });
  }

  // ---------------------------------------------------------------- the audit log (§14)

  /** What the dashboard did, at the mock clock's now. */
  private record(action: string, metadata: Parameters<MockAudit["record"]>[1]) {
    this.audit.record(action, metadata, this.scheduler.now());
  }

  listAuditEvents(q: AuditEventQuery, opts?: CallOptions): Promise<Page<AuditEvent>> {
    return this.call(opts?.signal, () => {
      if (!this.opts.capabilities.operations.includes("viewAuditLog"))
        throw new DataSourceError("unauthorized", "this credential cannot view the audit log");
      return this.audit.list(q);
    });
  }

  watchAuditEvents(onChange: () => void, _onError?: (e: DataSourceError) => void): Unsubscribe {
    return this.audit.watch(onChange);
  }

  // ---------------------------------------------------------------- metrics (§18), from the log history

  private metrics<T>(signal: AbortSignal | undefined, w: MetricsWindow, body: () => T): Promise<T> {
    return this.call(signal, () => {
      if (!this.opts.capabilities.operations.includes("viewMetrics"))
        throw new DataSourceError("unauthorized", "this credential cannot view metrics");
      if (!(w.end > w.start) || !Number.isInteger(w.numBuckets) || w.numBuckets < 1 || w.numBuckets > 1000)
        throw new DataSourceError("invalid_request", "a metrics window needs start < end and 1–1000 buckets");
      return body();
    });
  }

  functionRate(fn: string, metric: FunctionMetric, w: MetricsWindow, opts?: CallOptions): Promise<Timeseries> {
    return this.metrics(opts?.signal, w, () => metrics.functionRate(this.logs, fn, metric, w));
  }

  cacheHitPercentage(fn: string, w: MetricsWindow, opts?: CallOptions): Promise<Timeseries> {
    return this.metrics(opts?.signal, w, () => metrics.cacheHitPercentage(this.logs, fn, w));
  }

  latencyPercentiles(fn: string, percentiles: number[], w: MetricsWindow, opts?: CallOptions) {
    return this.metrics(opts?.signal, w, () => {
      if (percentiles.some((p) => !(p > 0 && p <= 100)))
        throw new DataSourceError("invalid_request", "percentiles are between 0 (excluded) and 100");
      return metrics.latencyPercentiles(this.logs, fn, percentiles, w);
    });
  }

  topFunctions(measure: TopKMeasure, w: MetricsWindow, k: number, opts?: CallOptions): Promise<TopKSeries> {
    return this.metrics(opts?.signal, w, () => metrics.topFunctions(this.logs, measure, w, Math.max(1, k)));
  }

  tableRate(table: string, metric: TableMetric, w: MetricsWindow, opts?: CallOptions): Promise<Timeseries> {
    return this.metrics(opts?.signal, w, () => {
      if (!this.tables.has(table)) throw new DataSourceError("not_found", `there is no table ${table}`);
      return metrics.tableRate(this.logs, table, metric, w);
    });
  }

  scheduledJobLag(w: MetricsWindow, opts?: CallOptions): Promise<Timeseries> {
    return this.metrics(opts?.signal, w, () => metrics.scheduledJobLag(this.logs, w));
  }

  // ---------------------------------------------------------------- topology (§22), simulated

  private canViewTopology() {
    if (!this.opts.capabilities.operations.includes("viewMetrics"))
      throw new DataSourceError("unauthorized", "this credential cannot view the deployment's topology");
  }

  getTopology(opts?: CallOptions): Promise<Topology> {
    return this.call(opts?.signal, () => {
      this.canViewTopology();
      return this.topology.snapshot();
    });
  }

  watchTopology(onTopology: (t: Topology) => void, onError: (e: DataSourceError) => void): Unsubscribe {
    let live = true;
    const deliver = () => {
      if (!live) return;
      try {
        this.canViewTopology();
        onTopology(this.topology.snapshot());
      } catch (e) {
        onError(toDataSourceError(e));
      }
    };
    const first = setTimeout(deliver, 0);
    const every = this.opts.topologyIntervalMs ?? 1000;
    const timer = setInterval(() => {
      this.topology.step(every);
      deliver();
    }, every);
    return () => {
      live = false;
      clearTimeout(first);
      clearInterval(timer);
    };
  }
}

const logMatches = (e: LogEntry, f: LogFilter) =>
  (f.function === undefined || e.function?.path === f.function) &&
  (f.levels === undefined || f.levels.includes(e.level));
