// Log streams (STUDY-59), as Convex's crates/model/src/log_sinks and crates/log_streaming: `_log_sinks` rows
// (one per sink type, at most 8), a manager that batches events (every 5 s or 4096 events) and hands them
// to each active sink, and a worker that starts the sinks the table asks for (verifying new ones) and marks
// them active or failed. Every sink type runs: webhook and local here, S3 export's stub as Convex's, and the
// providers (Datadog, Axiom, Sentry, PostHog) in log-sinks-providers.ts (STUDY-70).

import { createHmac, randomUUID } from "node:crypto";
import { appendFile, open } from "node:fs/promises";
import { DEPLOYMENT_AUDIT_LOG_TABLE, directFetch, type Engine, LOG_SINKS_TABLE, type Tx } from "@bunvex/core";
import { decodeId, toJsonValue, type Value } from "@bunvex/values";
import { type HttpProxy, proxiedFetch } from "./http-proxy.ts";
import { eventJsonV2, type LogEvent, type LogTopic } from "./log-events.ts";
import { backoff, EgressFailure, passes, SINK_USER_AGENT, type Sink, statusText } from "./log-sink-http.ts";
import {
  type AxiomConfig,
  AxiomSink,
  type DatadogConfig,
  DatadogSink,
  type PostHogErrorTrackingConfig,
  PostHogErrorTrackingSink,
  type PostHogLogsConfig,
  PostHogLogsSink,
  type SentryConfig,
  SentrySink,
} from "./log-sinks-providers.ts";

// ---------------------------------------------------------------- the model

export type SinkState =
  | { type: "pending" }
  | { type: "restarting" }
  | { type: "failed"; reason: string }
  | { type: "active" }
  | { type: "deleting" };

export type WebhookConfig = {
  type: "webhook";
  url: string;
  format: "json" | "jsonl";
  hmacSecret: string;
  topics?: LogTopic[];
};
/** Every sink type's stored config (Convex's `SinkConfig`): bunvex runs `webhook`, `local` and `s3Export`. */
export type SinkConfig =
  | WebhookConfig
  | { type: "local"; path: string }
  | { type: "datadog"; [k: string]: unknown }
  | { type: "axiom"; [k: string]: unknown }
  | { type: "sentry"; [k: string]: unknown }
  | { type: "postHogLogs"; [k: string]: unknown }
  | { type: "postHogErrorTracking"; [k: string]: unknown }
  | { type: "s3Export"; [k: string]: unknown };
export type SinkType = SinkConfig["type"];
export type SinkRow = { _id: string; _creationTime: number; status: SinkState; config: SinkConfig };

/** Convex's `LOG_SINKS_LIMIT`. */
export const LOG_SINKS_LIMIT = 8;

/** Convex's `SinkType` Debug names, for its messages. */
export const SINK_TYPE_NAMES: Record<SinkType, string> = {
  local: "Local",
  datadog: "Datadog",
  webhook: "Webhook",
  axiom: "Axiom",
  sentry: "Sentry",
  postHogLogs: "PostHogLogs",
  postHogErrorTracking: "PostHogErrorTracking",
  s3Export: "S3Export",
};

/** A 32-hex-digit secret, as Convex's `generate_webhook_hmac_secret` (a UUID v4, simple form). */
export const newWebhookSecret = () => randomUUID().replaceAll("-", "");

export class LogSinkError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const rows = async (db: Tx) => (await db.asSystem(() => db.query(LOG_SINKS_TABLE).collect())) as unknown as SinkRow[];

export async function listSinks(db: Tx): Promise<SinkRow[]> {
  return rows(db);
}

/** Convex's `must_get`: a sink that exists and is not being deleted. */
export async function mustGetSink(db: Tx, id: string): Promise<SinkRow> {
  let number: number | null = null;
  try {
    number = decodeId(id).tableNumber;
  } catch {}
  // Convex's `_log_sinks` number (512 + 23).
  if (number !== 535) throw new LogSinkError(400, "InvalidLogStreamId", "The log stream id is invalid");
  const row = (await db.asSystem(() => db.get(LOG_SINKS_TABLE, id))) as unknown as SinkRow | null;
  if (!row || row.status.type === "deleting")
    throw new LogSinkError(
      404,
      "LogStreamDoesntExist",
      `No log stream with the given id ${id} exists for this deployment.`,
    );
  return row;
}

/** The live (not deleting) sink of a type, if any. */
export async function sinkOfType(db: Tx, type: SinkType): Promise<SinkRow | null> {
  return (await rows(db)).find((r) => r.config.type === type && r.status.type !== "deleting") ?? null;
}

/** Convex's `add_or_update`: at most 8 live sinks; an existing one of the type is replaced. The new id. */
export async function addOrUpdateSink(db: Tx, config: SinkConfig): Promise<string> {
  const all = await rows(db);
  if (all.filter((r) => r.status.type !== "deleting").length >= LOG_SINKS_LIMIT)
    throw new LogSinkError(
      400,
      "LogSinkQuotaExceeded",
      "Cannot add more LogSinks, the quota for this project has been reached.",
    );
  for (const r of all)
    if (r.config.type === config.type && r.status.type !== "deleting")
      await db.asSystem(() => db.patch(LOG_SINKS_TABLE, r._id, { status: { type: "deleting" } }));
  return (await db.asSystem(() =>
    db.insert(LOG_SINKS_TABLE, { status: { type: "pending" }, config } as never),
  )) as unknown as string;
}

export const patchSink = (db: Tx, id: string, fields: Partial<Pick<SinkRow, "status" | "config">>) =>
  db.asSystem(() => db.patch(LOG_SINKS_TABLE, id, fields as never));

// ---------------------------------------------------------------- sinks

/** Knobs, as Convex's (consts.rs, knobs.rs); tests shorten them. */
export type LogSinkOptions = {
  /** `LOG_MANAGER_AGGREGATION_INTERVAL` (5 s). */
  aggregationMs: number;
  /** `LOG_MANAGER_EVENT_RECV_BUFFER_SIZE` (4096): events held before a flush; more are dropped. */
  bufferSize: number;
  /** A webhook's backoff: from 1 s to 60 s, full jitter. */
  webhookBackoffMs: [initial: number, max: number];
  /** The local sink's: from 1 s to 10 s. */
  localBackoffMs: [initial: number, max: number];
  /** `SINK_STARTUP_TIMEOUT` (15 s). */
  startupTimeoutMs: number;
  /** `WEBHOOK_SINK_REQUEST_TIMEOUT` (30 s). */
  requestTimeoutMs: number;
  random: () => number;
  /** The provider sinks' backoff (STUDY-70): Convex's 500 ms to 60 s. */
  providerBackoffMs: [initial: number, max: number];
  /** The HTTP client of the provider sinks (tests redirect Datadog's and Axiom's fixed hosts). */
  fetch: typeof fetch;
  /**
   * The operator's proxy (STUDY-80 §3.2): the webhook, Datadog, Axiom and PostHog sinks go through it, as
   * Convex's fetch client; Sentry's does not (Convex's uses the `sentry` crate's own transport).
   */
  httpProxy: HttpProxy | null;
  /** The version sent where Convex sends its package's (`sdk.version`, `$lib_version`): "unknown", its fallback. */
  version: string;
};

export const defaultLogSinkOptions = (): LogSinkOptions => ({
  aggregationMs: Number(process.env.LOG_MANAGER_AGGREGATION_INTERVAL ?? 5000),
  bufferSize: Number(process.env.LOG_MANAGER_EVENT_RECV_BUFFER_SIZE ?? 4096),
  webhookBackoffMs: [1000, 60_000],
  localBackoffMs: [1000, 10_000],
  startupTimeoutMs: 15_000,
  requestTimeoutMs: 30_000,
  random: Math.random,
  providerBackoffMs: [500, 60_000],
  fetch: ((input, init) => directFetch(input, init)) as typeof fetch,
  httpProxy: null,
  version: "unknown",
});

/** Convex's `WEBHOOK_SINK_MAX_LOGS_PER_BATCH`. */
const WEBHOOK_BATCH = 128;

/** The deployment's metadata each webhook event carries (Convex's `LoggingDeploymentMetadata`; DV-304). */
export type DeploymentMetadata = {
  deployment_name: string;
  deployment_type: null;
  deployment_ref: null;
  project_name: null;
  project_slug: null;
  deployment_region: null;
};

export class WebhookSink implements Sink {
  readonly capacity = 8;
  private stopped = false;
  constructor(
    private readonly config: WebhookConfig,
    private readonly metadata: () => DeploymentMetadata,
    private readonly o: LogSinkOptions,
  ) {}

  verify() {
    return this.post([{ timestamp: Date.now(), event: { topic: "verification" } }], 3);
  }

  async send(events: LogEvent[]) {
    const kept = events.filter((e) => passes(this.config.topics, e));
    for (let i = 0; i < kept.length; i += WEBHOOK_BATCH) {
      try {
        await this.post(kept.slice(i, i + WEBHOOK_BATCH), 6);
      } catch (e) {
        // Once active, a failed batch is dropped (Convex logs it).
        console.error(`log stream (webhook): a batch was dropped: ${(e as Error).message}`);
      }
    }
  }

  stop() {
    this.stopped = true;
  }

  private async post(events: LogEvent[], attempts: number) {
    const meta = this.metadata();
    const items = events.map((e) => ({ ...eventJsonV2(e), deployment: meta }));
    const body = this.config.format === "json" ? JSON.stringify(items) : items.map((x) => JSON.stringify(x)).join("\n");
    const signature = createHmac("sha256", this.config.hmacSecret).update(body).digest("hex");
    let last = "";
    for (let n = 0; n < attempts; n++) {
      if (n > 0) await backoff(this.o, this.o.webhookBackoffMs, n - 1, () => this.stopped);
      if (this.stopped) throw new EgressFailure("the log stream stopped", false);
      try {
        const r = await this.o.fetch(this.config.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-webhook-signature": `sha256=${signature}`,
            "user-agent": SINK_USER_AGENT,
          },
          body,
          signal: AbortSignal.timeout(this.o.requestTimeoutMs),
        });
        await r.arrayBuffer().catch(() => undefined);
        if (r.status < 400) return;
        const transient = r.status >= 500 || [408, 421, 425, 429].includes(r.status);
        if (!transient) throw new EgressFailure(`endpoint rejected the request with ${statusText(r)}`, true);
        last = `endpoint returned ${statusText(r)}`;
      } catch (e) {
        if (e instanceof EgressFailure) throw e;
        last = (e as Error).message;
      }
    }
    throw new EgressFailure(`gave up after ${attempts} attempts, last failure: ${last}`, false);
  }
}

/** Convex's local sink: every event, V2 JSON, one per line, appended and synced; retried forever. */
export class LocalSink implements Sink {
  readonly capacity = 50;
  private stopped = false;
  constructor(
    private readonly path: string,
    private readonly o: LogSinkOptions,
  ) {}

  async verify() {}

  async send(events: LogEvent[]) {
    const text = events.map((e) => `${JSON.stringify(eventJsonV2(e))}\n`).join("");
    for (let n = 0; !this.stopped; n++) {
      try {
        await appendFile(this.path, text);
        const f = await open(this.path, "r");
        await f.sync();
        await f.close();
        return;
      } catch (e) {
        console.error(`log stream (local): writing ${this.path} failed, retrying: ${(e as Error).message}`);
        await backoff(this.o, this.o.localBackoffMs, n, () => this.stopped);
      }
    }
  }

  stop() {
    this.stopped = true;
  }
}

/** Convex's S3 export sink in the open-source backend: it starts, and drains what it is given. */
class DrainingSink implements Sink {
  readonly capacity = 8;
  async verify() {}
  async send() {}
  stop() {}
}

// ---------------------------------------------------------------- the manager

/** A running sink and its queue of drains. */
type Running = { id: string; sink: Sink; queue: LogEvent[][]; busy: boolean };

/**
 * Convex's `LogManager`: `send` buffers events (only while some sink is active); every `aggregationMs`, or
 * once the buffer is full, the batch goes to each active sink's queue. The startup worker follows
 * `_log_sinks` (it runs on start and after each commit to the table).
 */
export class LogManager {
  private sinks = new Map<SinkType, Running>();
  private buffer: LogEvent[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private passing: Promise<void> | null = null;
  private again = false;
  private closed = false;
  readonly stats = { dropped: 0, delivered: 0 };

  constructor(
    private readonly engine: Engine,
    readonly options: LogSinkOptions = defaultLogSinkOptions(),
    private readonly metadata: () => DeploymentMetadata = () => ({
      deployment_name: engine.instanceName,
      deployment_type: null,
      deployment_ref: null,
      project_name: null,
      project_slug: null,
      deployment_region: null,
    }),
  ) {}

  /** Concurrency, sent every `concurrencyMs` when it changed (Convex's `ConcurrencyStats`, each metrics bucket). */
  private concurrencyTimer: ReturnType<typeof setInterval> | null = null;
  private lastConcurrency = "";

  watchConcurrency(
    read: () => Omit<Extract<LogEvent["event"], { topic: "concurrency_stats" }>, "topic">,
    everyMs = 60_000,
  ) {
    this.concurrencyTimer = setInterval(() => {
      if (!this.active) return;
      const c = read();
      const key = JSON.stringify(c);
      if (key === this.lastConcurrency) return;
      this.lastConcurrency = key;
      this.send([{ timestamp: Date.now(), event: { topic: "concurrency_stats", ...c } }]);
    }, everyMs);
    this.concurrencyTimer.unref?.();
  }

  /**
   * Each audit log event, once committed (Convex streams `DeploymentAuditLogEvent`s after the commit): its
   * metadata as Convex's internal JSON.
   */
  private streamAuditEvents(ids: string[]) {
    void this.engine
      .query(async (db) =>
        db.asSystem(async () => {
          const out: LogEvent[] = [];
          for (const id of ids) {
            const d = (await db.get(DEPLOYMENT_AUDIT_LOG_TABLE, id)) as unknown as {
              _creationTime: number;
              action: string;
              metadata: Value;
            } | null;
            if (d)
              out.push({
                timestamp: d._creationTime,
                event: { topic: "audit_log", action: d.action, metadata: toJsonValue(d.metadata) },
              });
          }
          return out;
        }),
      )
      .then((events) => this.send(events))
      .catch(() => undefined);
  }

  /** Watch `_log_sinks`, insert the local sink if asked (Convex's `--local-log-sink`), and start what is there. */
  async start(localSinkPath?: string) {
    if (localSinkPath) {
      // Convex's `add_on_startup`: a local sink replaces the stored one.
      await this.engine.mutation(async (db) => {
        for (const r of await rows(db))
          if (r.config.type === "local") await db.asSystem(() => db.delete(LOG_SINKS_TABLE, r._id));
        await addOrUpdateSink(db, { type: "local", path: localSinkPath });
      }, "_system/log_sink_worker");
    }
    const table = () => this.engine.catalog.tables.get(LOG_SINKS_TABLE)?.byId.id;
    const audit = () => this.engine.catalog.tables.get(DEPLOYMENT_AUDIT_LOG_TABLE)?.byId.id;
    this.engine.committer.onCommit((entries) => {
      const id = table();
      if (entries.some((e) => e.source !== "log_sink_worker" && e.writes.some((w) => w.index === id))) this.wake();
      if (!this.active) return;
      const auditIndex = audit();
      const inserted = new Set<string>();
      for (const e of entries)
        for (const w of e.writes) if (w.index === auditIndex && w.id !== null) inserted.add(w.id);
      if (inserted.size > 0) this.streamAuditEvents([...inserted]);
    }, "log streams");
    this.timer = setInterval(() => this.flush(), this.options.aggregationMs);
    this.timer.unref?.();
    this.wake();
    await this.passing;
  }

  /** Whether any sink is active: events are only gathered then (Convex's `active_sinks_count`). */
  get active(): boolean {
    return this.sinks.size > 0;
  }

  send(events: LogEvent[]) {
    if (!this.active || this.closed) return;
    for (const e of events) {
      if (this.buffer.length >= this.options.bufferSize) {
        this.stats.dropped++;
        continue;
      }
      this.buffer.push(e);
    }
    if (this.buffer.length >= this.options.bufferSize) this.flush();
  }

  /** Hand the buffered events to each sink. */
  flush() {
    if (this.buffer.length === 0) return;
    const drain = this.buffer;
    this.buffer = [];
    for (const r of this.sinks.values()) {
      if (r.queue.length >= r.sink.capacity) {
        this.stats.dropped += drain.length;
        continue;
      }
      r.queue.push(drain);
      void this.pump(r);
    }
  }

  private async pump(r: Running) {
    if (r.busy) return;
    r.busy = true;
    try {
      while (r.queue.length > 0 && !this.closed) {
        const drain = r.queue.shift()!;
        await r.sink.send(drain);
        this.stats.delivered += drain.length;
      }
    } finally {
      r.busy = false;
    }
  }

  /** Wait until every queued drain was handed to its sink (tests). */
  async idle() {
    this.flush();
    for (let i = 0; i < 2000; i++) {
      if ([...this.sinks.values()].every((r) => r.queue.length === 0 && !r.busy) && !this.passing) return;
      await Bun.sleep(5);
    }
  }

  /** Run the startup worker again (serialized; a request during a pass runs one more). */
  wake() {
    if (this.closed) return;
    if (this.passing) {
      this.again = true;
      return;
    }
    this.passing = (async () => {
      try {
        do {
          this.again = false;
          await this.pass();
        } while (this.again && !this.closed);
      } catch (e) {
        if (!this.closed) console.error("log streams: the worker failed", e);
      } finally {
        this.passing = null;
      }
    })();
  }

  /** Convex's startup worker pass: remove deleted sinks, start pending and restarting ones, restart active ones. */
  private async pass() {
    const all = await this.engine.query((db) => rows(db));
    for (const r of all) {
      const type = r.config.type;
      const running = this.sinks.get(type);
      if (r.status.type === "deleting") {
        if (running?.id === r._id) {
          running.sink.stop();
          this.sinks.delete(type);
        }
        await this.engine.mutation(async (db) => {
          await db.asSystem(() => db.delete(LOG_SINKS_TABLE, r._id));
        }, "_system/log_sink_worker");
      } else if (r.status.type === "pending" || r.status.type === "restarting") {
        const status = await this.startSink(r, r.status.type === "pending");
        await this.engine.mutation(async (db) => {
          const now = (await db.asSystem(() => db.get(LOG_SINKS_TABLE, r._id))) as unknown as SinkRow | null;
          if (now && now.status.type === r.status.type) await patchSink(db, r._id, { status });
        }, "_system/log_sink_worker");
      } else if (r.status.type === "active" && running?.id !== r._id) {
        // Active in the table but not running here (a restart): start it again without verifying.
        await this.engine.mutation((db) => patchSink(db, r._id, { status: { type: "restarting" } }), "_system/log_sink_worker");
        this.again = true;
      }
    }
  }

  private async startSink(r: SinkRow, verify: boolean): Promise<SinkState> {
    let sink: Sink;
    const c = r.config;
    // Through the operator's proxy, as Convex's fetch client; Sentry's transport is its own (STUDY-80).
    const proxied = { ...this.options, fetch: proxiedFetch(this.options.fetch, this.options.httpProxy) };
    if (c.type === "webhook")
      sink = new WebhookSink(c, this.metadata, {
        ...this.options,
        fetch: proxiedFetch(directFetch, this.options.httpProxy),
      });
    else if (c.type === "local") sink = new LocalSink(c.path, this.options);
    else if (c.type === "s3Export") sink = new DrainingSink();
    else if (c.type === "datadog") sink = new DatadogSink(c as unknown as DatadogConfig, proxied, this.metadata);
    else if (c.type === "axiom") sink = new AxiomSink(c as unknown as AxiomConfig, proxied, this.metadata);
    else if (c.type === "sentry") sink = new SentrySink(c as unknown as SentryConfig, this.options, this.metadata);
    else if (c.type === "postHogLogs")
      sink = new PostHogLogsSink(c as unknown as PostHogLogsConfig, proxied, this.metadata);
    else sink = new PostHogErrorTrackingSink(c as unknown as PostHogErrorTrackingConfig, proxied, this.metadata);
    if (verify) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          sink.verify(),
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("Timed out verifying the log stream endpoint")),
              this.options.startupTimeoutMs,
            );
          }),
        ]);
      } catch (e) {
        sink.stop();
        // A failed update leaves the running sink of the type as it was (Convex's).
        return { type: "failed", reason: (e as Error).message };
      } finally {
        clearTimeout(timer);
      }
    }
    this.sinks.get(c.type)?.sink.stop();
    this.sinks.set(c.type, { id: r._id, sink, queue: [], busy: false });
    return { type: "active" };
  }

  stop() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    if (this.concurrencyTimer) clearInterval(this.concurrencyTimer);
    for (const r of this.sinks.values()) r.sink.stop();
    this.sinks.clear();
  }
}
