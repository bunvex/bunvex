// Traces exported over OTLP (STUDY-131 AD-26, a bunvex addition; Convex's open-source backend exports none).
// bunvex's own exporter, by the owner's decision (no `@opentelemetry/*` dependency): OTLP/HTTP with the JSON
// encoding, POSTed to `<endpoint>/v1/traces`, configured by the OpenTelemetry SDK's standard environment
// variables. Spans are batched as the SDK's BatchSpanProcessor does: a bounded queue that drops when full,
// a batch sent when it fills or after a delay, one export at a time, retried with backoff on the codes OTLP
// calls retryable, and flushed when the server closes.
//
// The JSON follows the OTLP specification's JSON mapping of `ExportTraceServiceRequest`
// (opentelemetry-proto, `opentelemetry/proto/collector/trace/v1`): trace and span ids as lowercase hex (not
// base64, the one exception to protobuf's JSON mapping), enums as integers, 64-bit integers (times in Unix
// nanoseconds, `intValue`) as decimal strings, and field names in lowerCamelCase.
import {
  type AttributeValue,
  directFetch,
  parseSampler,
  type Sampler,
  type Span,
  type SpanSink,
  unixNanos,
} from "@bunvex/core";

/** What the exporter needs; `tracingFromEnv` reads it from the environment. */
export type OtlpConfig = {
  /** Where batches are POSTed: the traces endpoint itself (`…/v1/traces`). */
  url: string;
  headers: Record<string, string>;
  /** One export's timeout (OTEL_EXPORTER_OTLP_TIMEOUT; the SDK's default 10 s). */
  timeoutMs: number;
  sampler: Sampler;
  /** The resource's attributes, `service.name` included. */
  resource: Record<string, string>;
  /** The BatchSpanProcessor's knobs (OTEL_BSP_*): the SDK's defaults 2048, 512, 5000 ms. */
  maxQueueSize: number;
  maxBatchSize: number;
  scheduleDelayMs: number;
  /** Retries of a batch after a retryable failure, and their backoff (full jitter, doubling). */
  maxRetries: number;
  initialBackoffMs: number;
  maxBackoffMs: number;
  /** How long a close waits for the last spans to be sent (OTEL_BSP_EXPORT_TIMEOUT; 30 s). */
  shutdownTimeoutMs: number;
  /** For tests. */
  fetch?: typeof fetch;
};

export const OTLP_DEFAULTS = {
  timeoutMs: 10_000,
  maxQueueSize: 2048,
  maxBatchSize: 512,
  scheduleDelayMs: 5000,
  maxRetries: 5,
  initialBackoffMs: 1000,
  maxBackoffMs: 30_000,
  shutdownTimeoutMs: 30_000,
};

/** The service name when neither OTEL_SERVICE_NAME nor OTEL_RESOURCE_ATTRIBUTES names one. */
export const DEFAULT_SERVICE_NAME = "bunvex";

/**
 * A W3C-baggage-style list, as OTEL_EXPORTER_OTLP_HEADERS and OTEL_RESOURCE_ATTRIBUTES are written:
 * `key1=value1,key2=value2`, each value percent-decoded. An entry without `=` or with an empty key is
 * skipped and reported.
 */
export function parseKeyValueList(text: string | undefined, what: string, warn: (m: string) => void) {
  const out: Record<string, string> = {};
  if (!text) return out;
  for (const entry of text.split(",")) {
    if (entry.trim() === "") continue;
    const eq = entry.indexOf("=");
    const key = eq < 0 ? "" : entry.slice(0, eq).trim();
    if (key === "") {
      warn(`bunvex tracing: ignoring "${entry.trim()}" in ${what}: not key=value`);
      continue;
    }
    const raw = entry.slice(eq + 1).trim();
    try {
      out[key] = decodeURIComponent(raw);
    } catch {
      warn(`bunvex tracing: ignoring "${key}" in ${what}: its value is not percent-encoded correctly`);
    }
  }
  return out;
}

const positive = (v: string | undefined, fallback: number) => {
  const n = v === undefined || v.trim() === "" ? Number.NaN : Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

/**
 * Tracing's configuration from the OpenTelemetry SDK's environment variables, or null when it is off: no
 * endpoint set, OTEL_SDK_DISABLED=true, or OTEL_TRACES_EXPORTER without `otlp` (e.g. `none`).
 *
 * - OTEL_EXPORTER_OTLP_TRACES_ENDPOINT is the traces URL as is; else OTEL_EXPORTER_OTLP_ENDPOINT is the
 *   base, and `v1/traces` is appended to it (the specification's rule for the two).
 * - OTEL_EXPORTER_OTLP_HEADERS, overridden key by key by OTEL_EXPORTER_OTLP_TRACES_HEADERS.
 * - OTEL_EXPORTER_OTLP_(TRACES_)TIMEOUT, in ms.
 * - OTEL_EXPORTER_OTLP_(TRACES_)PROTOCOL: only `http/json` is spoken; another value is reported, and JSON
 *   is sent all the same (an OTLP/HTTP receiver takes both encodings on the same path).
 * - OTEL_TRACES_SAMPLER / OTEL_TRACES_SAMPLER_ARG (default `parentbased_always_on`).
 * - OTEL_SERVICE_NAME (default `bunvex`), OTEL_RESOURCE_ATTRIBUTES.
 * - OTEL_BSP_MAX_QUEUE_SIZE, OTEL_BSP_MAX_EXPORT_BATCH_SIZE, OTEL_BSP_SCHEDULE_DELAY,
 *   OTEL_BSP_EXPORT_TIMEOUT.
 */
export function tracingFromEnv(
  env: Record<string, string | undefined> = process.env,
  warn: (m: string) => void = console.warn,
): OtlpConfig | null {
  if (env.OTEL_SDK_DISABLED?.trim().toLowerCase() === "true") return null;
  const exporters = env.OTEL_TRACES_EXPORTER?.split(",").map((e) => e.trim().toLowerCase());
  if (exporters?.some((e) => e !== "") && !exporters.includes("otlp")) {
    if (!exporters.every((e) => e === "none" || e === ""))
      warn(`bunvex tracing: OTEL_TRACES_EXPORTER "${env.OTEL_TRACES_EXPORTER}" is not supported; only otlp is`);
    return null;
  }
  const signal = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim();
  const base = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  const url = signal ? signal : base ? `${base.replace(/\/+$/, "")}/v1/traces` : null;
  if (url === null) return null;
  try {
    new URL(url);
  } catch {
    warn(`bunvex tracing: the OTLP endpoint "${url}" is not a URL; tracing is off`);
    return null;
  }
  const protocol = (env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL ?? env.OTEL_EXPORTER_OTLP_PROTOCOL)?.trim();
  if (protocol && protocol !== "http/json")
    warn(`bunvex tracing: OTLP protocol "${protocol}" is not supported; sending http/json`);
  const headers = {
    ...parseKeyValueList(env.OTEL_EXPORTER_OTLP_HEADERS, "OTEL_EXPORTER_OTLP_HEADERS", warn),
    ...parseKeyValueList(env.OTEL_EXPORTER_OTLP_TRACES_HEADERS, "OTEL_EXPORTER_OTLP_TRACES_HEADERS", warn),
  };
  const resource = parseKeyValueList(env.OTEL_RESOURCE_ATTRIBUTES, "OTEL_RESOURCE_ATTRIBUTES", warn);
  // OTEL_SERVICE_NAME wins over a `service.name` in OTEL_RESOURCE_ATTRIBUTES (the SDK's rule).
  resource["service.name"] = env.OTEL_SERVICE_NAME?.trim() || resource["service.name"] || DEFAULT_SERVICE_NAME;
  const maxQueueSize = Math.max(1, Math.floor(positive(env.OTEL_BSP_MAX_QUEUE_SIZE, OTLP_DEFAULTS.maxQueueSize)));
  return {
    ...OTLP_DEFAULTS,
    url,
    headers,
    timeoutMs: positive(
      env.OTEL_EXPORTER_OTLP_TRACES_TIMEOUT ?? env.OTEL_EXPORTER_OTLP_TIMEOUT,
      OTLP_DEFAULTS.timeoutMs,
    ),
    sampler: parseSampler(env.OTEL_TRACES_SAMPLER, env.OTEL_TRACES_SAMPLER_ARG, warn),
    resource,
    maxQueueSize,
    // The SDK's rule: a batch is never bigger than the queue.
    maxBatchSize: Math.min(
      maxQueueSize,
      Math.max(1, Math.floor(positive(env.OTEL_BSP_MAX_EXPORT_BATCH_SIZE, OTLP_DEFAULTS.maxBatchSize))),
    ),
    scheduleDelayMs: positive(env.OTEL_BSP_SCHEDULE_DELAY, OTLP_DEFAULTS.scheduleDelayMs),
    shutdownTimeoutMs: positive(env.OTEL_BSP_EXPORT_TIMEOUT, OTLP_DEFAULTS.shutdownTimeoutMs),
  };
}

/** The config with the deployment's name among the resource's attributes (`bunvex.instance_name`). */
export function withInstance(config: OtlpConfig, instanceName: string): OtlpConfig {
  if (!instanceName || "bunvex.instance_name" in config.resource) return config;
  return { ...config, resource: { ...config.resource, "bunvex.instance_name": instanceName } };
}

// ---------------------------------------------------------------------------------------------- encoding

/** An OTLP `KeyValue` with its `AnyValue`: a string, a bool, an int (decimal string) or a double. */
function keyValue(key: string, v: AttributeValue): string {
  let value: string;
  if (typeof v === "string") value = `{"stringValue":${JSON.stringify(v)}}`;
  else if (typeof v === "boolean") value = `{"boolValue":${v}}`;
  else if (Number.isSafeInteger(v)) value = `{"intValue":"${v}"}`;
  // protobuf's JSON mapping writes the non-finite doubles as strings.
  else if (Number.isFinite(v)) value = `{"doubleValue":${v}}`;
  else value = `{"doubleValue":"${Number.isNaN(v) ? "NaN" : v > 0 ? "Infinity" : "-Infinity"}"}`;
  return `{"key":${JSON.stringify(key)},"value":${value}}`;
}

const attributesJson = (attrs: Record<string, AttributeValue>) =>
  `[${Object.entries(attrs)
    .map(([k, v]) => keyValue(k, v))
    .join(",")}]`;

function spanJson(s: Span): string {
  let out = `{"traceId":"${s.traceId}","spanId":"${s.spanId}"`;
  if (s.parentSpanId !== null) out += `,"parentSpanId":"${s.parentSpanId}"`;
  if (s.traceState) out += `,"traceState":${JSON.stringify(s.traceState)}`;
  out +=
    `,"name":${JSON.stringify(s.name)},"kind":${s.kind}` +
    `,"startTimeUnixNano":"${unixNanos(s.start)}","endTimeUnixNano":"${unixNanos(s.end)}"` +
    `,"attributes":${attributesJson(s.attributes)}`;
  if (s.status !== 0)
    out += `,"status":{"code":${s.status}${s.statusMessage ? `,"message":${JSON.stringify(s.statusMessage)}` : ""}}`;
  return `${out}}`;
}

/** An `ExportTraceServiceRequest`: one resource, one instrumentation scope, the batch's spans. */
export function encodeTraces(resource: Record<string, string>, spans: Span[]): string {
  return (
    `{"resourceSpans":[{"resource":{"attributes":${attributesJson(resource)}},` +
    `"scopeSpans":[{"scope":{"name":"bunvex"},"spans":[${spans.map(spanJson).join(",")}]}]}]}`
  );
}

// ---------------------------------------------------------------------------------------------- the exporter

/** OTLP/HTTP's retryable answers (the specification's "Retryable Response Codes"). */
const RETRYABLE = new Set([429, 502, 503, 504]);

export type OtlpStats = {
  /** Spans the collector accepted. */
  exported: number;
  /** Spans dropped because the queue was full (or the exporter closed). */
  dropped: number;
  /** Spans whose batch failed for good (a non-retryable answer, or retries spent), or the collector rejected. */
  failed: number;
  /** Spans waiting in the queue. */
  queued: number;
};

export class OtlpExporter implements SpanSink {
  private queue: Span[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private exporting: Promise<void> | null = null;
  private closing = false;
  /** A flush asked for everything queued, full batch or not. */
  private flushing = false;
  /** Cuts a backoff short when the exporter closes. */
  private wakeBackoff: (() => void) | null = null;
  private counts = { exported: 0, dropped: 0, failed: 0 };
  private lastWarning = 0;
  private readonly send: typeof fetch;

  constructor(readonly config: OtlpConfig) {
    this.send = config.fetch ?? directFetch;
  }

  get stats(): OtlpStats {
    return { ...this.counts, queued: this.queue.length };
  }

  add(span: Span) {
    if (this.closing || this.queue.length >= this.config.maxQueueSize) {
      this.counts.dropped++;
      return;
    }
    this.queue.push(span);
    if (this.queue.length >= this.config.maxBatchSize) this.kick();
    else if (this.timer === null && this.exporting === null) {
      this.timer = setTimeout(() => this.kick(), this.config.scheduleDelayMs);
      this.timer.unref?.();
    }
  }

  /** Start exporting now, unless an export is under way (it takes the queue on when it ends). */
  private kick() {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.exporting) return;
    this.exporting = this.pump().finally(() => {
      this.exporting = null;
      if (this.queue.length > 0 && !this.closing) {
        if (this.queue.length >= this.config.maxBatchSize || this.flushing) this.kick();
        else if (this.timer === null) {
          this.timer = setTimeout(() => this.kick(), this.config.scheduleDelayMs);
          this.timer.unref?.();
        }
      }
    });
  }

  /** Send full batches while there are, and the rest too once closing. */
  private async pump() {
    do {
      const batch = this.queue.splice(0, this.config.maxBatchSize);
      if (batch.length === 0) return;
      await this.exportBatch(batch);
    } while (
      this.queue.length >= this.config.maxBatchSize ||
      ((this.closing || this.flushing) && this.queue.length > 0)
    );
  }

  private async exportBatch(batch: Span[]) {
    const body = encodeTraces(this.config.resource, batch);
    for (let attempt = 0; ; attempt++) {
      let retryAfterMs: number | null = null;
      let why: string;
      try {
        const res = await this.send(this.config.url, {
          method: "POST",
          headers: { ...this.config.headers, "content-type": "application/json" },
          body,
          signal: AbortSignal.timeout(this.config.timeoutMs),
        });
        const text = await res.text().catch(() => "");
        if (res.ok) {
          // A partial success names the spans the collector rejected.
          const rejected = rejectedSpans(text);
          this.counts.exported += batch.length - rejected;
          this.counts.failed += rejected;
          if (rejected > 0) this.warn(`the collector rejected ${rejected} spans`);
          return;
        }
        why = `HTTP ${res.status}`;
        if (!RETRYABLE.has(res.status)) {
          this.counts.failed += batch.length;
          this.warn(`the collector refused a batch (${why}): ${text.slice(0, 200)}`);
          return;
        }
        retryAfterMs = retryAfter(res.headers.get("retry-after"));
      } catch (e) {
        // A network error or a timeout: retryable.
        why = (e as Error).message;
      }
      if (attempt >= this.config.maxRetries || this.closing) {
        this.counts.failed += batch.length;
        this.warn(`a batch of ${batch.length} spans failed (${why})`);
        return;
      }
      const cap = Math.min(this.config.maxBackoffMs, this.config.initialBackoffMs * 2 ** attempt);
      await this.backoff(retryAfterMs ?? Math.random() * cap);
    }
  }

  private backoff(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(done, ms);
      t.unref?.();
      const self = this;
      function done() {
        clearTimeout(t);
        self.wakeBackoff = null;
        resolve();
      }
      this.wakeBackoff = done;
    });
  }

  /** At most one warning a minute: a collector that is down must not flood the server's log. */
  private warn(message: string) {
    const now = Date.now();
    if (now - this.lastWarning < 60_000) return;
    this.lastWarning = now;
    console.warn(`bunvex tracing: ${message}`);
  }

  /** Send what is queued now, and wait for it (tests; a close does it too). */
  async flush() {
    this.flushing = true;
    try {
      this.kick();
      while (this.exporting) await this.exporting;
    } finally {
      this.flushing = false;
    }
  }

  /**
   * Stop taking spans and send the ones queued, for at most `shutdownTimeoutMs`. A batch being retried
   * gets one last attempt; what is left after the timeout is dropped.
   */
  async close() {
    if (this.closing) return this.exporting ?? undefined;
    this.closing = true;
    this.wakeBackoff?.();
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const drain = (async () => {
      while (this.exporting) await this.exporting;
      if (this.queue.length > 0) {
        this.exporting = this.pump().finally(() => {
          this.exporting = null;
        });
        await this.exporting;
      }
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.config.shutdownTimeoutMs);
      timer.unref?.();
    });
    await Promise.race([drain, timeout]);
    clearTimeout(timer);
    this.counts.dropped += this.queue.length;
    this.queue.length = 0;
  }
}

/** `partialSuccess.rejectedSpans` of an `ExportTraceServiceResponse` (an int64: a string or a number). */
function rejectedSpans(text: string): number {
  if (!text.includes("rejectedSpans")) return 0;
  try {
    const n = Number(JSON.parse(text)?.partialSuccess?.rejectedSpans ?? 0);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** A `Retry-After` header: delay seconds, or an HTTP date; null when absent or unreadable. */
function retryAfter(header: string | null): number | null {
  if (header === null) return null;
  const s = Number(header);
  if (Number.isFinite(s) && s >= 0) return Math.min(s * 1000, 60_000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? null : Math.min(Math.max(0, at - Date.now()), 60_000);
}
