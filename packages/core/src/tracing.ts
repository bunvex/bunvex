// Traces (STUDY-131 AD-26, a bunvex addition): spans for a request's whole path, exported over OTLP by the
// server (otlp.ts). Convex creates `fastrace` spans in about 25 crates but its open-source backend installs
// no reporter, so a self-hosted Convex drops them; bunvex exports them when an endpoint is configured.
//
// The current span travels in an AsyncLocalStorage, as the function log's and determinism's state already
// do: a layer opens a child of whatever span is current, without a parameter threaded through the engine,
// the transaction and the committer. Where work crosses a queue (a commit waiting for its group, a sync
// transition, a scheduled job) the parent is captured explicitly instead, and `detached` keeps a queue's
// own async context from carrying a span into work that is not part of it.
//
// Off (`NO_TRACER`, no endpoint), every hook is a check of `tracer.on` and nothing else: no span, no clock
// read, no AsyncLocalStorage run.
import { AsyncLocalStorage } from "node:async_hooks";
import { monotonicNow, realRandomBytes } from "./determinism.ts";

export type AttributeValue = string | number | bigint | boolean;

/** OTLP's `Span.SpanKind` values. */
export const SPAN_KIND = { internal: 1, server: 2, client: 3, producer: 4, consumer: 5 } as const;
export type SpanKind = (typeof SPAN_KIND)[keyof typeof SPAN_KIND];

/** OTLP's `Status.StatusCode` values. */
export const STATUS = { unset: 0, ok: 1, error: 2 } as const;

/** A caller's trace context, from a W3C `traceparent` (and `tracestate`) header. */
export type RemoteParent = { traceId: string; spanId: string; sampled: boolean; traceState?: string };

/** Where finished spans go: the exporter's queue. `add` never throws and never blocks. */
export interface SpanSink {
  add(span: Span): void;
}

// ---------------------------------------------------------------------------------------------- ids

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));
/** Random bytes drawn in blocks: one `getRandomValues` per 4 KiB of ids rather than one per id. */
const pool = new Uint8Array(4096);
let poolAt = pool.length;

function randomHex(bytes: number): string {
  for (;;) {
    if (poolAt + bytes > pool.length) {
      realRandomBytes(pool);
      poolAt = 0;
    }
    let s = "";
    let zero = true;
    for (let i = 0; i < bytes; i++) {
      const b = pool[poolAt++]!;
      if (b !== 0) zero = false;
      s += HEX[b];
    }
    // An all-zero id is invalid in W3C and OTLP.
    if (!zero) return s;
  }
}

/** A new 16-byte trace id, as 32 lowercase hex digits. */
export const newTraceId = () => randomHex(16);
/** A new 8-byte span id, as 16 lowercase hex digits. */
export const newSpanId = () => randomHex(8);

// ---------------------------------------------------------------------------------------------- time

/**
 * `performance.timeOrigin` in nanoseconds, exactly: span times are `performance.now()` readings (monotonic,
 * sub-millisecond) and become Unix nanoseconds only when exported.
 */
const ORIGIN_NS =
  BigInt(Math.floor(performance.timeOrigin)) * 1_000_000n + BigInt(Math.round((performance.timeOrigin % 1) * 1e6));

/** A span time (a `performance.now()` reading, in ms) as Unix nanoseconds in decimal, OTLP JSON's form. */
export const unixNanos = (at: number): string => (ORIGIN_NS + BigInt(Math.round(at * 1e6))).toString();

// ---------------------------------------------------------------------------------------------- spans

export class Span {
  /** When it ended (a `performance.now()` reading); 0 while it runs. */
  end = 0;
  readonly attributes: Record<string, AttributeValue> = {};
  status: number = STATUS.unset;
  statusMessage = "";

  constructor(
    readonly tracer: Tracer,
    /** Settable: a request's span is named once it is known to be sampled (its route costs a URL parse). */
    public name: string,
    readonly traceId: string,
    readonly spanId: string,
    readonly parentSpanId: string | null,
    readonly kind: SpanKind = SPAN_KIND.internal,
    readonly start: number = monotonicNow(),
    readonly traceState?: string,
  ) {}

  set(key: string, value: AttributeValue | null | undefined): this {
    if (value !== null && value !== undefined) this.attributes[key] = value;
    return this;
  }

  /** Mark it failed, with the error's message. */
  fail(error: unknown): this {
    this.status = STATUS.error;
    this.statusMessage = error instanceof Error ? error.message : String(error);
    return this;
  }

  /** A span under this one, in the same trace. */
  child(name: string, kind: SpanKind = SPAN_KIND.internal, start?: number): Span {
    return new Span(this.tracer, name, this.traceId, newSpanId(), this.spanId, kind, start, this.traceState);
  }

  /** End it (once) and hand it to the exporter. */
  finish(at: number = monotonicNow()) {
    if (this.end !== 0) return;
    this.end = at;
    this.tracer.sink?.add(this);
  }
}

// ---------------------------------------------------------------------------------------------- sampling

/**
 * The samplers of the OpenTelemetry SDK's `OTEL_TRACES_SAMPLER`: `always_on`, `always_off`, `traceidratio`
 * and their `parentbased_` forms, which follow a remote parent's sampled flag and use the root sampler only
 * for a new trace.
 */
export type Sampler = { root: "always_on" | "always_off" | "traceidratio"; parentBased: boolean; ratio: number };

export const DEFAULT_SAMPLER: Sampler = { root: "always_on", parentBased: true, ratio: 1 };

/**
 * `OTEL_TRACES_SAMPLER` / `OTEL_TRACES_SAMPLER_ARG`. The SDK's default is `parentbased_always_on`, and a
 * ratio's default 1.0; an unknown sampler or a ratio outside [0, 1] is reported and the default used, as the
 * SDK specification asks.
 */
export function parseSampler(
  name: string | undefined,
  arg: string | undefined,
  warn: (message: string) => void = console.warn,
): Sampler {
  const n = (name ?? "").trim().toLowerCase();
  if (n === "") return DEFAULT_SAMPLER;
  const parentBased = n.startsWith("parentbased_");
  const root = parentBased ? n.slice("parentbased_".length) : n;
  if (root !== "always_on" && root !== "always_off" && root !== "traceidratio") {
    warn(`bunvex tracing: unsupported OTEL_TRACES_SAMPLER "${name}"; using parentbased_always_on`);
    return DEFAULT_SAMPLER;
  }
  let ratio = 1;
  if (root === "traceidratio" && arg !== undefined && arg.trim() !== "") {
    const r = Number(arg);
    if (Number.isFinite(r) && r >= 0 && r <= 1) ratio = r;
    else warn(`bunvex tracing: OTEL_TRACES_SAMPLER_ARG "${arg}" is not a ratio in [0, 1]; using 1.0`);
  }
  return { root, parentBased, ratio };
}

/** 2^56: the trace id's last 7 bytes are its random part (W3C trace context level 2). */
const RATIO_SCALE = 2 ** 56;

/** Whether a trace is recorded: decided from its id, so every service that sees it decides the same. */
export function sampled(s: Sampler, traceId: string, parent: RemoteParent | null): boolean {
  if (parent && s.parentBased) return parent.sampled;
  if (s.root === "always_on") return true;
  if (s.root === "always_off") return false;
  if (s.ratio >= 1) return true;
  if (s.ratio <= 0) return false;
  return Number.parseInt(traceId.slice(18), 16) < s.ratio * RATIO_SCALE;
}

// ---------------------------------------------------------------------------------------------- traceparent

const TRACEPARENT = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(-.*)?$/;
const ALL_ZERO = /^0+$/;

/**
 * A W3C `traceparent` header (Trace Context, §3.2): `version-traceid-parentid-flags`, lowercase hex. Version
 * `ff`, all-zero ids, or extra fields on version `00` make it invalid (null: the request starts a new trace).
 * A later version is read by its first four fields, as the specification asks.
 */
export function parseTraceparent(header: string | null, traceState?: string | null): RemoteParent | null {
  if (!header) return null;
  const m = TRACEPARENT.exec(header.trim());
  if (!m) return null;
  const [, version, traceId, spanId, flags, rest] = m as unknown as [string, string, string, string, string, string?];
  if (version === "ff" || (version === "00" && rest !== undefined)) return null;
  if (ALL_ZERO.test(traceId) || ALL_ZERO.test(spanId)) return null;
  const p: RemoteParent = { traceId, spanId, sampled: (Number.parseInt(flags, 16) & 1) === 1 };
  if (traceState) p.traceState = traceState;
  return p;
}

// ---------------------------------------------------------------------------------------------- the tracer

/** The context of a root that was not sampled: its descendants open no span, and inherit none from elsewhere. */
const UNSAMPLED = Symbol("unsampled");
const context = new AsyncLocalStorage<Span | typeof UNSAMPLED>();
/** Whether any tracer was ever on: until then `detached` costs nothing. */
let anyOn = false;

export class Tracer {
  /** Whether spans are recorded at all: false for `NO_TRACER`, and every hook checks it first. */
  readonly on: boolean;

  constructor(
    readonly sink: SpanSink | null,
    readonly sampler: Sampler = DEFAULT_SAMPLER,
  ) {
    this.on = sink !== null;
    if (this.on) anyOn = true;
  }

  /**
   * The root span of a new trace, or of the caller's trace when `parent` came with the request; null when
   * the sampler leaves the trace out. Whatever span is current is ignored: a root starts a trace.
   */
  root(name: string, kind: SpanKind = SPAN_KIND.internal, parent: RemoteParent | null = null): Span | null {
    if (!this.on) return null;
    const traceId = parent?.traceId ?? newTraceId();
    if (!sampled(this.sampler, traceId, parent)) return null;
    return new Span(this, name, traceId, newSpanId(), parent?.spanId ?? null, kind, undefined, parent?.traceState);
  }

  /** A child of the current span, or null when none is current (or its trace is not sampled). */
  child(name: string, kind: SpanKind = SPAN_KIND.internal): Span | null {
    if (!this.on) return null;
    const p = context.getStore();
    return p instanceof Span ? p.child(name, kind) : null;
  }

  /** The current span, if any. */
  current(): Span | null {
    if (!this.on) return null;
    const p = context.getStore();
    return p instanceof Span ? p : null;
  }

  /**
   * Run `fn` with `span` current. A null span (a root the sampler left out) still hides whatever span the
   * caller's context holds, so the run's work never joins an unrelated trace.
   */
  within<T>(span: Span | null, fn: () => T): T {
    return this.on ? context.run(span ?? UNSAMPLED, fn) : fn();
  }
}

/** Tracing off: no endpoint configured. */
export const NO_TRACER = new Tracer(null);

/**
 * Run `fn` with no current span: a queue drained or a timer set from it does not inherit the span of
 * whoever happened to start it (the committer's group, which runs in its first caller's context).
 */
export function detached<T>(fn: () => T): T {
  return anyOn ? context.exit(fn) : fn();
}

// ---------------------------------------------------------------------------------------------- index reads

type IndexReads = { start: number; end: number; intervals: number; rows: number; busyMs: number };

/**
 * A transaction's index reads, gathered per index and reported as one span each when the transaction ends
 * (never one per row or per page): the number of store reads (`intervals`), the rows they returned, and the
 * time spent in them. The span runs from the first read of the index to the end of its last.
 */
export class IndexReadSpans {
  private readonly byIndex = new Map<{ table: string; name: string }, IndexReads>();

  constructor(readonly parent: Span) {}

  /** One read of `index` that began at `start` and returned `rows` rows. */
  record(index: { table: string; name: string }, rows: number, start: number) {
    const end = monotonicNow();
    const a = this.byIndex.get(index);
    if (a) {
      a.end = end;
      a.intervals++;
      a.rows += rows;
      a.busyMs += end - start;
    } else this.byIndex.set(index, { start, end, intervals: 1, rows, busyMs: end - start });
  }

  finish() {
    for (const [ix, a] of this.byIndex) {
      const name = `${ix.table}.${ix.name}`;
      const s = this.parent.child(`index ${name}`, SPAN_KIND.internal, a.start);
      s.set("bunvex.index", name)
        .set("bunvex.index.intervals", a.intervals)
        .set("bunvex.index.rows", a.rows)
        .set("bunvex.index.read_us", Math.round(a.busyMs * 1000));
      s.finish(a.end);
    }
    this.byIndex.clear();
  }
}

// ---------------------------------------------------------------------------------------------- commits

/**
 * One commit's way through the committer: queued behind the group being written (`wait`), checked against
 * the commits since its snapshot (`validate`), applied and flushed with its write batch (`write`). Reported
 * when the commit is answered, as a `commit` span with those three under it.
 */
export class CommitSpans {
  readonly enqueued = monotonicNow();
  validateStart = 0;
  validateEnd = 0;
  writeStart = 0;
  writeEnd = 0;
  batchCommits = 0;
  batchDocuments = 0;

  constructor(
    readonly parent: Span,
    readonly documents: number,
    readonly indexEntries: number,
  ) {}

  /** The commit was answered: its ts, or the error it was refused with. */
  settle(ts: bigint | null, error?: unknown) {
    const end = monotonicNow();
    const c = this.parent.child("commit", SPAN_KIND.internal, this.enqueued);
    c.set("bunvex.commit.documents", this.documents).set("bunvex.commit.index_entries", this.indexEntries);
    if (ts !== null) c.set("bunvex.commit.ts", ts);
    if (error !== undefined) c.fail(error);
    const waited = this.validateStart || end;
    c.child("commit.wait", SPAN_KIND.internal, this.enqueued).finish(waited);
    if (this.validateStart) c.child("commit.validate", SPAN_KIND.internal, this.validateStart).finish(this.validateEnd);
    if (this.writeStart)
      c.child("commit.write", SPAN_KIND.internal, this.writeStart)
        .set("bunvex.commit.batch_commits", this.batchCommits)
        .set("bunvex.commit.batch_documents", this.batchDocuments)
        .finish(this.writeEnd || end);
    c.finish(end);
  }
}
