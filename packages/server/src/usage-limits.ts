// Usage limits (STUDY-61), as Convex's crates/usage_limits and local_backend/src/usage_limits.rs, which run
// in its open-source backend too: an in-memory meter of this process's usage per UTC day and month (Convex
// seeds it from its cloud's history; self-hosted it starts at 0, `seedStatus: "pending"`), `_usage_limits`
// rows set through `/api/v1/*_usage_limit*`, and a worker that every 10 s disables the deployment
// (`_backend_state.usage_limit`) while an enabled `disable` limit is reached, with Convex's audit events.
import {
  type Caller,
  type Engine,
  insertAuditLogEvents,
  readBackendState,
  SYSTEM_ACTOR,
  setUsageLimitStopState,
  type Tx,
  USAGE_LIMITS_TABLE,
} from "@bunvex/core";
import { decodeId } from "@bunvex/values";
import { auditActor } from "./audit-log.ts";
import type { Functions } from "./functions.ts";

// ---------------------------------------------------------------- metrics

/** The isolate actions' compute metric: Convex's wire name (rule 5's wire-name exception, DV-308). */
const ACTION_COMPUTE_ISOLATE = "actionComputeConvexGbHours";

/** Convex's `UsageLimitMetric`, by wire name, its display unit and how a limit converts to raw units. */
export const USAGE_METRICS = {
  actionComputeCpuGbHours: { unit: "GB-hours", raw: 3600 },
  [ACTION_COMPUTE_ISOLATE]: { unit: "GB-hours", raw: 3600 },
  actionComputeNodeJsGbHours: { unit: "GB-hours", raw: 3600 },
  aiGatewayCostDollars: { unit: "dollars", raw: 1 },
  dataEgressGb: { unit: "GB", raw: 2 ** 30 },
  databaseIoGb: { unit: "GB", raw: 2 ** 30 },
  functionCalls: { unit: "calls", raw: 1 },
  queryMutationComputeGbHours: { unit: "GB-hours", raw: 3600 },
  searchQueryGb: { unit: "Query-GB", raw: 1 },
} as const;
export type UsageMetric = keyof typeof USAGE_METRICS;
const METRICS = Object.keys(USAGE_METRICS).sort() as UsageMetric[];
const WINDOWS = ["day", "month"] as const;
const LIMIT_TYPES = ["warning", "disable"] as const;
type Window = (typeof WINDOWS)[number];
type LimitType = (typeof LIMIT_TYPES)[number];

export type UsageLimitConfig = {
  metric: UsageMetric;
  window: Window;
  limitType: LimitType;
  limit: bigint;
  enabled: boolean;
};
type Row = UsageLimitConfig & { _id: string };

/** Convex's `MEMORY_USED_MB` for isolate functions (its 64 MiB heap) and Node actions (512 MB). */
export const ISOLATE_MEMORY_MB = 64;
export const NODE_MEMORY_MB = 512;

// ---------------------------------------------------------------- the meter

/** The UTC day of a wall-clock ms (days since the epoch). */
const dayOf = (ms: number) => Math.floor(ms / 86_400_000);
/** The UTC month of a wall-clock ms, as `year * 12 + month`. */
const monthOf = (ms: number) => {
  const d = new Date(ms);
  return d.getUTCFullYear() * 12 + d.getUTCMonth();
};

/**
 * This process's usage in raw units, per metric, for the current UTC day and month (Convex's `UsageMeter`:
 * its hourly and daily stores sum exactly these windows). Only positive deltas count; a sample of a past
 * window is dropped.
 */
export class UsageMeter {
  private day = { key: -1, totals: new Map<UsageMetric, number>() };
  private month = { key: -1, totals: new Map<UsageMetric, number>() };
  /** The current month's span in ms, so most samples need no date arithmetic. */
  private monthSpan = { start: 0, end: 0 };

  constructor(private readonly now: () => number = Date.now) {}

  private monthKey(ms: number): number {
    if (ms >= this.monthSpan.start && ms < this.monthSpan.end) return this.month.key;
    const key = monthOf(ms);
    if (key > this.month.key) {
      const y = Math.floor(key / 12);
      const m = key % 12;
      this.monthSpan = { start: Date.UTC(y, m, 1), end: Date.UTC(y, m + 1, 1) };
    }
    return key;
  }

  record(metric: UsageMetric, delta: number, at = this.now()) {
    if (!(delta > 0)) return;
    this.add(this.day, dayOf(at), metric, delta);
    this.add(this.month, this.monthKey(at), metric, delta);
  }

  private add(w: { key: number; totals: Map<UsageMetric, number> }, key: number, metric: UsageMetric, delta: number) {
    if (key < w.key) return;
    if (key > w.key) {
      w.key = key;
      w.totals.clear();
    }
    w.totals.set(metric, (w.totals.get(metric) ?? 0) + delta);
  }

  /** The raw usage of `metric` in the window containing now. */
  usage(metric: UsageMetric, window: Window): number {
    const now = this.now();
    const w = window === "day" ? this.day : this.month;
    return w.key === (window === "day" ? dayOf(now) : monthOf(now)) ? (w.totals.get(metric) ?? 0) : 0;
  }

  /** A finished execution (Convex's `FunctionCall` usage event, as `UsageLimitRecorder` reads it). */
  recordExecution(e: {
    udfType: "Query" | "Mutation" | "Action" | "HttpAction";
    environment: "isolate" | "node";
    /** Seconds; a cached query's is 0. */
    executionTime: number;
    userExecutionTime: number | null;
    memoryMb: number;
    databaseIoBytes: number;
    /** An action's `fetch` request bodies and file reads (Convex's network and storage egress). */
    dataEgressBytes?: number;
    /** An action's file storage calls, counted as function calls as Convex's are. */
    storageCalls?: number;
    /** Text and vector searches' `bytes_searched`, into `searchQueryGb` (in GB, as Convex's recorder). */
    searchQueryBytes?: number;
    /** False for a `_system/` function: Convex counts its compute and bandwidth, not the call. */
    tracked?: boolean;
  }) {
    if (e.tracked !== false) this.record("functionCalls", 1);
    this.record("functionCalls", e.storageCalls ?? 0);
    this.record("dataEgressGb", e.dataEgressBytes ?? 0);
    this.record("searchQueryGb", (e.searchQueryBytes ?? 0) / 2 ** 30);
    const gbs = (seconds: number) => (e.memoryMb / 1024) * seconds;
    if (e.udfType === "Action" || e.udfType === "HttpAction") {
      if (e.environment === "node") this.record("actionComputeNodeJsGbHours", gbs(e.executionTime));
      else {
        this.record(ACTION_COMPUTE_ISOLATE, gbs(e.executionTime));
        if (e.userExecutionTime !== null) this.record("actionComputeCpuGbHours", gbs(e.userExecutionTime));
      }
    } else this.record("queryMutationComputeGbHours", gbs(e.executionTime));
    this.record("databaseIoGb", e.databaseIoBytes);
  }
}

const limitRaw = (c: { metric: UsageMetric; limit: bigint }) => Number(c.limit) * USAGE_METRICS[c.metric].raw;
const display = (metric: UsageMetric, raw: number) => raw / USAGE_METRICS[metric].raw;

// ---------------------------------------------------------------- rows

export class UsageLimitError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
const bad = (code: string, message: string) => new UsageLimitError(400, code, message);

const rows = async (db: Tx) => (await db.asSystem(() => db.query(USAGE_LIMITS_TABLE).collect())) as unknown as Row[];
const configOf = (r: Row): UsageLimitConfig => ({
  metric: r.metric,
  window: r.window,
  limitType: r.limitType,
  limit: r.limit,
  enabled: r.enabled ?? true,
});
const configValue = (c: UsageLimitConfig) => ({ ...c });
const responseOf = (r: Row) => ({
  id: r._id,
  metric: r.metric,
  window: r.window,
  limitType: r.limitType,
  limit: Number(r.limit),
  enabled: r.enabled ?? true,
});

/** `_usage_limits`'s number (512 + 40). */
const USAGE_LIMITS_NUMBER = 552;

async function mustGet(db: Tx, id: string): Promise<Row> {
  let number: number | null = null;
  try {
    number = decodeId(id).tableNumber;
  } catch {}
  if (number !== USAGE_LIMITS_NUMBER) throw bad("InvalidId", "Invalid ID for table _usage_limits");
  const row = (await db.asSystem(() => db.get(USAGE_LIMITS_TABLE, id))) as unknown as Row | null;
  if (!row) throw new UsageLimitError(404, "UsageLimitNotFound", "The usage limit couldn't be found.");
  return row;
}

/** A request body's config: every field required, as Convex's `UsageLimitConfigRequest`. */
function configArg(b: unknown): UsageLimitConfig {
  const body = (b ?? {}) as Record<string, unknown>;
  for (const k of ["metric", "window", "limitType", "limit", "enabled"])
    if (body[k] === undefined) throw bad("BadJsonBody", `missing field \`${k}\``);
  const variant = (k: string, allowed: readonly string[]) => {
    const v = body[k];
    if (typeof v !== "string" || !allowed.includes(v))
      throw bad("BadJsonBody", `${k}: unknown variant \`${String(v)}\``);
    return v;
  };
  const metric = variant("metric", METRICS) as UsageMetric;
  const window = variant("window", WINDOWS) as Window;
  const limitType = variant("limitType", LIMIT_TYPES) as LimitType;
  if (typeof body.limit !== "number" || !Number.isInteger(body.limit) || body.limit < 0)
    throw bad("BadJsonBody", "limit: invalid value, expected u64");
  if (typeof body.enabled !== "boolean") throw bad("BadJsonBody", "enabled: invalid type, expected a boolean");
  if (body.limit === 0) throw bad("InvalidUsageLimit", "Usage limits must have a positive limit.");
  return { metric, window, limitType, limit: BigInt(body.limit), enabled: body.enabled };
}

const sameSelector = (a: UsageLimitConfig, b: UsageLimitConfig) =>
  a.metric === b.metric && a.window === b.window && a.limitType === b.limitType;

// ---------------------------------------------------------------- the routes

export const USAGE_LIMIT_ROUTE =
  /^\/api\/v1\/(get_current_usage|list_usage_limits|create_usage_limit|update_usage_limit|delete_usage_limit)(?:\/([^/]+))?$/;

export async function usageLimitRoute(
  deps: { engine: Engine; functions: Functions; meter: UsageMeter; wake: () => void },
  route: string,
  id: string | undefined,
  req: Request,
  caller: Caller,
): Promise<Response | null> {
  const { engine, functions, meter } = deps;
  const audit = (db: Tx, action: string, metadata: Record<string, unknown>) =>
    insertAuditLogEvents(db, [{ action, metadata: metadata as never }], auditActor(caller));
  const body = async () => {
    try {
      return (await req.json()) as unknown;
    } catch (e) {
      throw bad("BadJsonBody", (e as Error).message);
    }
  };
  const checkAboveCurrent = (c: UsageLimitConfig) => {
    if (!c.enabled) return;
    const current = meter.usage(c.metric, c.window);
    if (limitRaw(c) < current)
      throw bad(
        "UsageLimitBelowCurrentUsage",
        `Usage limit of ${c.limit} is below the current ${c.window} usage of ${display(c.metric, current)} for ${c.metric}. Set the limit at or above the current usage.`,
      );
  };
  const needId = () => {
    if (id === undefined) throw new UsageLimitError(404, "NotFound", `no route for /api/v1/${route}`);
    return decodeURIComponent(id);
  };
  if (route === "get_current_usage" && req.method === "GET") {
    functions.requireOperation(caller, "ViewUsage");
    const metrics = Object.fromEntries(
      METRICS.map((m) => [
        m,
        {
          unit: USAGE_METRICS[m].unit,
          usage: { current_day: display(m, meter.usage(m, "day")), current_month: display(m, meter.usage(m, "month")) },
        },
      ]),
    );
    return Response.json({ metrics, seedStatus: "pending" });
  }
  if (route === "list_usage_limits" && req.method === "GET") {
    functions.requireOperation(caller, "ViewUsageLimits");
    const all = await engine.query((db) => rows(db));
    return Response.json({ usageLimits: all.map(responseOf) });
  }
  if (req.method !== "POST") return null;
  functions.requireOperation(caller, "WriteUsageLimits");
  if (route === "create_usage_limit") {
    const c = configArg(await body());
    checkAboveCurrent(c);
    const row = await engine.mutation(async (db) => {
      if ((await rows(db)).some((r) => sameSelector(configOf(r), c)))
        throw bad("DuplicateUsageLimit", "A usage limit already exists for this metric, window, and limit type.");
      const newId = (await db.asSystem(() =>
        db.insert(USAGE_LIMITS_TABLE, configValue(c) as never),
      )) as unknown as string;
      await audit(db, "create_usage_limit", { id: newId, config: configValue(c) });
      return { ...c, _id: newId };
    }, "create_usage_limit");
    deps.wake();
    return Response.json({ usageLimit: responseOf(row) });
  }
  if (route === "update_usage_limit") {
    const limitId = needId();
    const c = configArg(await body());
    const row = await engine.mutation(async (db) => {
      const old = await mustGet(db, limitId);
      if ((await rows(db)).some((r) => r._id !== old._id && sameSelector(configOf(r), c)))
        throw bad("DuplicateUsageLimit", "A usage limit already exists for this metric, window, and limit type.");
      checkAboveCurrent(c);
      await db.asSystem(() => db.replace(USAGE_LIMITS_TABLE, old._id, configValue(c) as never));
      await audit(db, "update_usage_limit", {
        id: old._id,
        previous: configValue(configOf(old)),
        current: configValue(c),
      });
      return { ...c, _id: old._id };
    }, "update_usage_limit");
    deps.wake();
    return Response.json({ usageLimit: responseOf(row) });
  }
  if (route === "delete_usage_limit") {
    const limitId = needId();
    await engine.mutation(async (db) => {
      const old = await mustGet(db, limitId);
      await db.asSystem(() => db.delete(USAGE_LIMITS_TABLE, old._id));
      await audit(db, "delete_usage_limit", { id: old._id, config: configValue(configOf(old)) });
    }, "delete_usage_limit");
    deps.wake();
    return new Response(null, { status: 200 });
  }
  return null;
}

// ---------------------------------------------------------------- the worker

/**
 * Convex's `UsageLimitWorker`: every `intervalMs` (10 s) and after each change to `_usage_limits`, the
 * limits against the meter. Each newly reached limit is audited once per window (`usage_limit_exceeded`,
 * again only for a higher limit); the deployment is disabled while an enabled `disable` limit is reached and
 * enabled again otherwise (`change_usage_limit_stop_state`).
 */
export class UsageLimitWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;
  private again = false;
  /** Per limit id: the window it was reported in and the highest limit reported. */
  private reported = new Map<string, { window: string; limit: bigint }>();

  constructor(
    private readonly engine: Engine,
    private readonly meter: UsageMeter,
    private readonly intervalMs = Number(process.env.USAGE_LIMIT_EVALUATE_INTERVAL_SECS ?? 10) * 1000,
    private readonly now: () => number = Date.now,
  ) {}

  start() {
    this.timer = setInterval(() => this.wake(), this.intervalMs);
    this.timer.unref?.();
    this.wake();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Evaluate now (serialized). */
  wake(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.again = false;
          await this.evaluate();
        } while (this.again);
      } catch (e) {
        console.error("usage limits: evaluation failed", e);
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  private windowKey(w: Window) {
    return w === "day" ? `d${dayOf(this.now())}` : `m${monthOf(this.now())}`;
  }

  private async evaluate() {
    await this.engine.mutation(async (db) => {
      const all = await rows(db);
      for (const id of [...this.reported.keys()]) if (!all.some((r) => r._id === id)) this.reported.delete(id);
      const events: { action: string; metadata: Record<string, unknown> }[] = [];
      let disable = false;
      for (const r of all) {
        const c = configOf(r);
        if (!c.enabled || this.meter.usage(c.metric, c.window) < limitRaw(c)) continue;
        if (c.limitType === "disable") disable = true;
        const window = this.windowKey(c.window);
        const seen = this.reported.get(r._id);
        if (seen && seen.window === window && seen.limit >= c.limit) continue;
        this.reported.set(r._id, { window, limit: c.limit });
        events.push({ action: "usage_limit_exceeded", metadata: { id: r._id, config: configValue(c) } });
      }
      const before = await setUsageLimitStopState(db, disable ? "disabled" : "none");
      if (before !== null)
        events.push({
          action: "change_usage_limit_stop_state",
          metadata: { old_state: before.usage_limit, new_state: disable ? "disabled" : "none" },
        });
      if (events.length > 0) await insertAuditLogEvents(db, events as never, SYSTEM_ACTOR);
    }, "usage_limit_enforcement");
  }
}

/** Whether a deployment is disabled by a usage limit now (tests). */
export async function usageLimitDisabled(engine: Engine): Promise<boolean> {
  return engine.query(async (db) => (await readBackendState(db)).usage_limit === "disabled");
}
