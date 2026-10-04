// The provider log stream sinks (STUDY-70), as Convex's crates/log_streaming/src/sinks: Datadog, Axiom,
// Sentry, PostHog Logs and PostHog Error Tracking. Their URLs, headers, batching, retries, verification and
// payloads are Convex's; the names Convex puts in them (`ddsource`, the deployment metadata key, the SDK and
// library name, PostHog's attribute and property prefixes, the verification `distinct_id`, the User-Agent)
// are bunvex's, as the owner decided (2026-10-03; DV-304's precedent).
import { randomUUID } from "node:crypto";
import { eventJsonV2, type LogEvent, type LogTopic, type StackFrame } from "./log-events.ts";
import {
  type BackoffOptions,
  EgressFailure,
  onlyExceptions,
  passes,
  postWithRetry,
  SINK_USER_AGENT,
  type Sink,
  statusText,
} from "./log-sink-http.ts";
import type { DeploymentMetadata } from "./log-sinks.ts";

export type ProviderOptions = BackoffOptions & {
  /** Every provider's backoff: Convex's 500 ms to 60 s, full jitter. */
  providerBackoffMs: [initial: number, max: number];
  /** The HTTP client (tests point the fixed provider hosts at a local endpoint). */
  fetch: typeof fetch;
  /** bunvex's version, where Convex sends its npm package's (`sdk.version`, `$lib_version`). */
  version: string;
};

/** The metadata key on each event (DV-304: `deployment`, where Convex has `convex`). */
const METADATA_KEY = "deployment";
const NAME = "bunvex";
const PROVIDER_ATTEMPTS = 6;

abstract class ProviderSink implements Sink {
  readonly capacity = 8;
  protected readonly state: { failures: number; stopped: boolean; backoffMs: [number, number] };
  constructor(
    protected readonly o: ProviderOptions,
    protected readonly metadata: () => DeploymentMetadata,
    protected readonly label: string,
  ) {
    this.state = { failures: 0, stopped: false, backoffMs: o.providerBackoffMs };
  }
  abstract verify(): Promise<void>;
  abstract send(events: LogEvent[]): Promise<void>;
  stop() {
    this.state.stopped = true;
  }
  /** Each batch on its own: a failed one is dropped (logged once), the next still sent. */
  protected async sendBatches(batches: string[], post: (body: string) => Promise<void>) {
    for (const body of batches)
      try {
        await post(body);
      } catch (e) {
        console.error(`log stream (${this.label}): a batch was dropped: ${(e as Error).message}`);
      }
  }
}

/** Convex's `build_sized_batches`: JSON items into arrays of at most `count` and `bytes` (brackets and commas counted). */
export function sizedBatches(items: string[], count: number, bytes: number): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  let size = 2;
  for (const item of items) {
    const add = Buffer.byteLength(item) + (cur.length > 0 ? 1 : 0);
    if (cur.length > 0 && (cur.length >= count || size + add > bytes)) {
      out.push(`[${cur.join(",")}]`);
      cur = [];
      size = 2;
    }
    size += Buffer.byteLength(item) + (cur.length > 0 ? 1 : 0);
    cur.push(item);
  }
  if (cur.length > 0) out.push(`[${cur.join(",")}]`);
  return out;
}

const verificationEvent = (): LogEvent => ({ timestamp: Date.now(), event: { topic: "verification" } });

// ---------------------------------------------------------------- Datadog

export type DatadogConfig = {
  type: "datadog";
  siteLocation: string;
  ddApiKey: string;
  ddTags: string[];
  service?: string;
  topics?: LogTopic[];
};

/** Convex's `DatadogSiteLocation` hosts. */
export const DATADOG_SITES: Record<string, string> = {
  US1: "datadoghq.com",
  US3: "us3.datadoghq.com",
  US5: "us5.datadoghq.com",
  EU: "datadoghq.eu",
  US1_FED: "ddog-gov.com",
  AP1: "ap1.datadoghq.com",
};

export class DatadogSink extends ProviderSink {
  private readonly url: string;
  private readonly hostname: string;
  constructor(
    private readonly c: DatadogConfig,
    o: ProviderOptions,
    metadata: () => DeploymentMetadata,
  ) {
    super(o, metadata, "datadog");
    this.url = `https://http-intake.logs.${DATADOG_SITES[c.siteLocation]}/api/v2/logs`;
    this.hostname = metadata().deployment_name;
  }

  private item(e: LogEvent) {
    return JSON.stringify({
      ddsource: NAME,
      ddtags: this.c.ddTags.join(","),
      hostname: this.hostname,
      service: this.c.service ?? null,
      ...eventJsonV2(e),
      [METADATA_KEY]: this.metadata(),
    });
  }

  private post(body: string) {
    return postWithRetry(
      this.o,
      this.state,
      this.url,
      { headers: { "content-type": "application/json", "dd-api-key": this.c.ddApiKey }, body },
      PROVIDER_ATTEMPTS,
    );
  }

  verify() {
    return this.post(`[${this.item(verificationEvent())}]`);
  }

  async send(events: LogEvent[]) {
    const items = events.filter((e) => passes(this.c.topics, e)).map((e) => this.item(e));
    await this.sendBatches(sizedBatches(items, 1000, 4 << 20), (b) => this.post(b));
  }
}

// ---------------------------------------------------------------- Axiom

export type AxiomConfig = {
  type: "axiom";
  apiKey: string;
  datasetName: string;
  attributes: { key: string; value: string }[];
  ingestUrl?: string;
  topics?: LogTopic[];
};

const AXIOM_DEFAULT = "https://api.axiom.co";

export class AxiomSink extends ProviderSink {
  private readonly url: string;
  private readonly attributes: Record<string, string>;
  constructor(
    private readonly c: AxiomConfig,
    o: ProviderOptions,
    metadata: () => DeploymentMetadata,
  ) {
    super(o, metadata, "axiom");
    const base = c.ingestUrl ?? AXIOM_DEFAULT;
    this.url =
      base === AXIOM_DEFAULT
        ? new URL(`${base}/v1/datasets/${c.datasetName}/ingest`).href
        : new URL(`${base}/v1/ingest/${c.datasetName}`).href;
    // A sorted map: keys in order, a repeated key keeps its last value (Convex's BTreeMap).
    const map = new Map<string, string>();
    for (const a of c.attributes) map.set(a.key, a.value);
    this.attributes = Object.fromEntries([...map].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  }

  private item(e: LogEvent) {
    const data = eventJsonV2(e);
    return JSON.stringify({
      _time: Math.floor(e.timestamp),
      data,
      attributes: this.attributes,
      [METADATA_KEY]: this.metadata(),
    });
  }

  private post(body: string) {
    return postWithRetry(
      this.o,
      this.state,
      this.url,
      { headers: { "content-type": "application/json", authorization: `Bearer ${this.c.apiKey}` }, body },
      PROVIDER_ATTEMPTS,
    );
  }

  verify() {
    return this.post(`[${this.item(verificationEvent())}]`);
  }

  async send(events: LogEvent[]) {
    const items = events.filter((e) => passes(this.c.topics, e)).map((e) => this.item(e));
    const batches: string[] = [];
    for (let i = 0; i < items.length; i += 10_000) batches.push(`[${items.slice(i, i + 10_000).join(",")}]`);
    await this.sendBatches(batches, (b) => this.post(b));
  }
}

// ---------------------------------------------------------------- Sentry

export type SentryConfig = { type: "sentry"; dsn: string; tags?: Record<string, string> };

/** A Sentry DSN, as the Sentry SDK parses it: `scheme://public[:secret]@host[:port]/[path/]project`. */
export function parseDsn(dsn: string) {
  const u = new URL(dsn);
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("unsupported scheme");
  if (!u.username) throw new Error("missing public key");
  const segments = u.pathname.split("/").filter((s) => s !== "");
  const project = segments.pop();
  if (!project) throw new Error("missing project id");
  const prefix = segments.length > 0 ? `/${segments.join("/")}/` : "/";
  return {
    publicKey: decodeURIComponent(u.username),
    secretKey: u.password ? decodeURIComponent(u.password) : null,
    envelopeUrl: `${u.protocol}//${u.host}${prefix}api/${project}/envelope/`,
  };
}

/** Convex's `SENTRY_*` queue: 30 envelopes waiting, more dropped. */
const SENTRY_QUEUE = 30;

export class SentrySink extends ProviderSink {
  private readonly dsn: ReturnType<typeof parseDsn>;
  /** Sends are off until this wall-clock ms (a 429, `Retry-After` or `X-Sentry-Rate-Limits`). */
  private disabledUntil = 0;
  private queue: string[] = [];
  private draining = false;
  constructor(
    private readonly c: SentryConfig,
    o: ProviderOptions,
    metadata: () => DeploymentMetadata,
  ) {
    super(o, metadata, "sentry");
    this.dsn = parseDsn(c.dsn);
  }

  /** The SDK sends nothing for an empty envelope: verification only needs a DSN that parses. */
  async verify() {}

  async send(events: LogEvent[]) {
    for (const e of events.filter(onlyExceptions)) {
      if (this.queue.length >= SENTRY_QUEUE) continue;
      this.queue.push(this.envelope(e));
    }
    await this.drain();
  }

  private envelope(e: LogEvent): string {
    const ev = e.event as Extract<LogEvent["event"], { topic: "exception" }>;
    const eventId = randomUUID().replaceAll("-", "");
    const meta = this.metadata();
    const type = { Query: "query", Mutation: "mutation", Action: "action", HttpAction: "http_action" }[
      ev.source.udfType
    ];
    const tags: Record<string, string> = { ...(this.c.tags ?? {}) };
    tags.func = ev.source.path;
    tags.func_type = type;
    tags.func_runtime = ev.runtime;
    tags.request_id = ev.source.requestId;
    if (ev.source.cached !== null && ev.source.udfType === "Query") tags.cached = String(ev.source.cached);
    const sortedTags = Object.fromEntries(Object.entries(tags).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    const user: Record<string, string> = {};
    if (ev.userIdentifier !== null) user.id = ev.userIdentifier;
    if (ev.ip !== null) user.ip_address = ev.ip;
    const frames = ev.frames === null ? null : [...ev.frames].reverse().map(sentryFrame);
    const exception: Record<string, unknown> = { type: "Error", value: ev.message };
    if (frames !== null) exception.stacktrace = { frames };
    const ts = e.timestamp / 1000;
    const event: Record<string, unknown> = {
      event_id: eventId,
      timestamp: Number.isInteger(ts) ? ts : ts,
      platform: "node",
      server_name: meta.deployment_name,
      user,
      tags: sortedTags,
      exception: { values: [exception] },
      sdk: { name: NAME, version: this.o.version },
    };
    if (ev.customData !== null && ev.customData !== undefined)
      event.contexts = { BunvexError: { type: "unknown", data: ev.customData } };
    const body = JSON.stringify(event);
    return `${JSON.stringify({ event_id: eventId })}\n${JSON.stringify({ type: "event", length: Buffer.byteLength(body) })}\n${body}\n`;
  }

  private async drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0 && !this.state.stopped) {
        const envelope = this.queue.shift()!;
        if (Date.now() < this.disabledUntil) continue; // rate limited: dropped
        const auth = [
          `Sentry sentry_key=${this.dsn.publicKey}`,
          "sentry_version=7",
          `sentry_timestamp=${Date.now() / 1000}`,
          `sentry_client=${NAME}/${this.o.version}`,
          ...(this.dsn.secretKey ? [`sentry_secret=${this.dsn.secretKey}`] : []),
        ].join(", ");
        try {
          const r = await this.o.fetch(this.dsn.envelopeUrl, {
            method: "POST",
            headers: { "x-sentry-auth": auth, "user-agent": SINK_USER_AGENT },
            body: envelope,
          });
          await r.arrayBuffer().catch(() => undefined);
          this.rateLimits(r);
        } catch (e) {
          console.error(`log stream (sentry): an event was dropped: ${(e as Error).message}`);
        }
      }
    } finally {
      this.draining = false;
    }
  }

  /** The SDK's rate limits: `X-Sentry-Rate-Limits`, else `Retry-After`, else a 429 for 60 s. */
  private rateLimits(r: Response) {
    const limits = r.headers.get("x-sentry-rate-limits");
    if (limits) {
      let secs = 0;
      for (const part of limits.split(",")) {
        const [s, categories] = part.trim().split(":");
        const n = Number(s);
        if (!Number.isFinite(n)) continue;
        const cats = (categories ?? "").split(";");
        if (cats.includes("") || cats.includes("error")) secs = Math.max(secs, n);
      }
      if (secs > 0) this.disabledUntil = Date.now() + secs * 1000;
      return;
    }
    const retryAfter = r.headers.get("retry-after");
    if (retryAfter !== null) {
      const n = Number(retryAfter);
      const at = Number.isFinite(n) ? Date.now() + n * 1000 : Date.parse(retryAfter);
      this.disabledUntil = Number.isFinite(at) ? at : Date.now() + 60_000;
      return;
    }
    if (r.status === 429) this.disabledUntil = Date.now() + 60_000;
  }
}

function sentryFrame(f: StackFrame) {
  const out: Record<string, unknown> = { function: f.functionName ?? "<anonymous>" };
  if (f.fileName !== null) out.filename = f.fileName;
  if (f.lineNumber !== null) out.lineno = f.lineNumber;
  if (f.columnNumber !== null) out.colno = f.columnNumber;
  out.in_app = f.fileName !== null && !f.fileName.includes("node_modules");
  return out;
}

// ---------------------------------------------------------------- PostHog

export const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";

/** Convex's verification of a PostHog token: `/decide?v=3`, one attempt. */
async function verifyPostHog(o: ProviderOptions, host: string, apiKey: string) {
  const u = new URL(host);
  const url = `${u.protocol}//${u.host}/decide?v=3`;
  try {
    const r = await o.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": SINK_USER_AGENT },
      body: JSON.stringify({ api_key: apiKey, distinct_id: `${NAME}-verification` }),
    });
    await r.arrayBuffer().catch(() => undefined);
    if (r.status < 400) return;
    const transient = r.status >= 500 || [408, 421, 425, 429].includes(r.status);
    throw new EgressFailure(
      transient ? `endpoint returned ${statusText(r)}` : `endpoint rejected the request with ${statusText(r)}`,
      !transient,
    );
  } catch (e) {
    throw new Error(`Failed to verify PostHog project token: ${(e as Error).message}`);
  }
}

export type PostHogLogsConfig = {
  type: "postHogLogs";
  apiKey: string;
  host?: string;
  serviceName?: string;
  topics?: LogTopic[];
};

/** PostHog Logs' topic names: Convex's, with the audit log and storage bandwidth renamed. */
const POSTHOG_TOPIC: Record<string, string> = {
  audit_log: "deployment_audit_log",
  storage_api_bandwidth: "storage_bandwidth",
};

export class PostHogLogsSink extends ProviderSink {
  private readonly url: string;
  private readonly serviceName: string;
  constructor(
    private readonly c: PostHogLogsConfig,
    o: ProviderOptions,
    metadata: () => DeploymentMetadata,
  ) {
    super(o, metadata, "postHogLogs");
    this.url = `${c.host ?? DEFAULT_POSTHOG_HOST}/i/v1/logs`;
    this.serviceName = c.serviceName ?? metadata().deployment_name;
  }

  verify() {
    return verifyPostHog(this.o, this.c.host ?? DEFAULT_POSTHOG_HOST, this.c.apiKey);
  }

  private record(e: LogEvent) {
    const ev = e.event;
    const json = eventJsonV2(e);
    let severity: [string, number] = ["INFO", 9];
    if (ev.topic === "console") {
      const level = ev.line.level;
      severity =
        level === "ERROR"
          ? ["ERROR", 17]
          : level === "WARN"
            ? ["WARN", 13]
            : level === "DEBUG"
              ? ["DEBUG", 5]
              : ["INFO", 9];
    } else if (ev.topic === "function_execution" && ev.error !== null) severity = ["ERROR", 17];
    const str = (key: string, value: string) => ({ key, value: { stringValue: value } });
    const attributes = [str(`${NAME}.topic`, POSTHOG_TOPIC[ev.topic] ?? ev.topic)];
    if (ev.topic === "console" || ev.topic === "function_execution") {
      const type = { Query: "query", Mutation: "mutation", Action: "action", HttpAction: "http_action" }[
        ev.source.udfType
      ];
      attributes.push(str(`${NAME}.function.path`, ev.source.path), str(`${NAME}.function.type`, type));
    }
    const ms = typeof json.timestamp === "number" ? json.timestamp : Math.floor(e.timestamp);
    return {
      timeUnixNano: `${BigInt(ms) * 1_000_000n}`,
      severityText: severity[0],
      severityNumber: severity[1],
      body: { stringValue: JSON.stringify(json) },
      attributes,
    };
  }

  async send(events: LogEvent[]) {
    const kept = events.filter((e) => passes(this.c.topics, e));
    const meta = this.metadata();
    const resource = {
      attributes: [
        { key: "service.name", value: { stringValue: this.serviceName } },
        { key: `${NAME}.deployment.name`, value: { stringValue: meta.deployment_name } },
      ],
    };
    const batches: string[] = [];
    for (let i = 0; i < kept.length; i += 400)
      batches.push(
        JSON.stringify({
          resourceLogs: [
            {
              resource,
              scopeLogs: [{ scope: { name: NAME }, logRecords: kept.slice(i, i + 400).map((e) => this.record(e)) }],
            },
          ],
        }),
      );
    await this.sendBatches(batches, (body) =>
      postWithRetry(
        this.o,
        this.state,
        this.url,
        { headers: { "content-type": "application/json", authorization: `Bearer ${this.c.apiKey}` }, body },
        PROVIDER_ATTEMPTS,
      ),
    );
  }
}

export type PostHogErrorTrackingConfig = { type: "postHogErrorTracking"; apiKey: string; host?: string };

/** chrono's `to_rfc3339` with AutoSi digits: `…:SS+00:00`, or `.fff` when there are milliseconds. */
function rfc3339(ms: number) {
  const iso = new Date(ms).toISOString(); // YYYY-MM-DDTHH:MM:SS.fffZ
  const base = iso.slice(0, 19);
  const frac = iso.slice(20, 23);
  return `${base}${frac === "000" ? "" : `.${frac}`}+00:00`;
}

export class PostHogErrorTrackingSink extends ProviderSink {
  private readonly url: string;
  constructor(
    private readonly c: PostHogErrorTrackingConfig,
    o: ProviderOptions,
    metadata: () => DeploymentMetadata,
  ) {
    super(o, metadata, "postHogErrorTracking");
    this.url = `${c.host ?? DEFAULT_POSTHOG_HOST}/i/v0/e/`;
  }

  verify() {
    return verifyPostHog(this.o, this.c.host ?? DEFAULT_POSTHOG_HOST, this.c.apiKey);
  }

  private capture(e: LogEvent) {
    const ev = e.event as Extract<LogEvent["event"], { topic: "exception" }>;
    const meta = this.metadata();
    const frames = ev.frames ?? [];
    const type = { Query: "query", Mutation: "mutation", Action: "action", HttpAction: "http_action" }[
      ev.source.udfType
    ];
    return {
      event: "$exception",
      distinct_id: ev.userIdentifier ?? meta.deployment_name,
      timestamp: rfc3339(Math.floor(e.timestamp)),
      properties: {
        $exception_list: [
          {
            type: "Error",
            value: ev.message,
            mechanism: { handled: false, type: "generic" },
            stacktrace: {
              type: "raw",
              frames: frames.map((f) => ({
                platform: "custom",
                lang: "javascript",
                filename: f.fileName,
                function: f.functionName ?? "<anonymous>",
                lineno: f.lineNumber,
                colno: f.columnNumber,
                in_app: true,
              })),
            },
          },
        ],
        $exception_level: "error",
        $exception_types: ["Error"],
        $exception_values: [ev.message],
        $exception_sources: frames.filter((f) => f.fileName !== null).map((f) => f.fileName),
        $exception_functions: frames.map((f) => f.functionName ?? "<anonymous>"),
        $lib: NAME,
        $lib_version: this.o.version,
        [`${NAME}_function`]: ev.source.path,
        [`${NAME}_function_type`]: type,
        [`${NAME}_function_runtime`]: ev.runtime,
        [`${NAME}_deployment`]: meta.deployment_name,
        [`${NAME}_deployment_type`]: meta.deployment_type,
        [`${NAME}_request_id`]: ev.source.requestId,
      },
    };
  }

  async send(events: LogEvent[]) {
    const kept = events.filter(onlyExceptions);
    const batches: string[] = [];
    for (let i = 0; i < kept.length; i += 100)
      batches.push(
        JSON.stringify({ api_key: this.c.apiKey, batch: kept.slice(i, i + 100).map((e) => this.capture(e)) }),
      );
    await this.sendBatches(batches, (body) =>
      postWithRetry(
        this.o,
        this.state,
        this.url,
        { headers: { "content-type": "application/json" }, body },
        PROVIDER_ATTEMPTS,
      ),
    );
  }
}
