// A small Prometheus registry and its text exposition format (version 0.0.4), for the server's `/metrics`
// (STUDY-114), as Convex's `CONVEX_METRICS_REGISTRY` and `TextEncoder` (crates/metrics/src/metrics.rs,
// crates/common/src/http/mod.rs `metrics`).
//
// Counters and histograms are recorded where things happen; values bunvex already keeps elsewhere (the
// committer's counts, the sync hub's, the process's memory) are read when scraped, so nothing counts twice.
// Histograms are Prometheus's own, cumulative `le` buckets (DV-378), where Convex's are VictoriaMetrics'
// `vmrange` ones.

type MetricType = "counter" | "gauge" | "histogram";
/** Label values, in the order of the family's label names. */
type LabelValues = readonly string[];
/** A collected sample: its label values (in the family's order) and its value. */
export type Sample = [labels: LabelValues, value: number];

const METRIC_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** A sample value as the format writes it: Go's `+Inf`, `-Inf` and `NaN`, else the shortest round-trip form. */
export function formatValue(v: number): string {
  if (v === Number.POSITIVE_INFINITY) return "+Inf";
  if (v === Number.NEGATIVE_INFINITY) return "-Inf";
  if (Number.isNaN(v)) return "NaN";
  return String(v);
}

const escapeHelp = (s: string) => s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
const escapeLabel = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");

/** `{a="x",b="y"}`, or nothing without labels. */
function labelSet(names: readonly string[], values: LabelValues, extra?: string): string {
  const parts: string[] = [];
  for (let i = 0; i < names.length; i++) parts.push(`${names[i]}="${escapeLabel(values[i] ?? "")}"`);
  if (extra) parts.push(extra);
  return parts.length ? `{${parts.join(",")}}` : "";
}

abstract class Family<T> {
  protected readonly children = new Map<string, { values: LabelValues; child: T }>();
  constructor(
    readonly name: string,
    readonly help: string,
    readonly type: MetricType,
    readonly labelNames: readonly string[],
  ) {}

  protected abstract make(): T;

  /** The child for these label values (one per distinct set, created on first use). */
  labels(...values: string[]): T {
    if (values.length !== this.labelNames.length)
      throw new Error(`${this.name}: expected ${this.labelNames.length} label values, got ${values.length}`);
    const key = values.join("\u0000");
    let c = this.children.get(key);
    if (!c) {
      c = { values, child: this.make() };
      this.children.set(key, c);
    }
    return c.child;
  }

  abstract write(out: string[]): void;
}

export class Counter {
  value = 0;
  inc(n = 1) {
    this.value += n;
  }
}

export class CounterFamily extends Family<Counter> {
  protected make() {
    return new Counter();
  }
  write(out: string[]) {
    for (const { values, child } of this.children.values())
      out.push(`${this.name}${labelSet(this.labelNames, values)} ${formatValue(child.value)}`);
  }
}

export class Histogram {
  /** Per bucket, the observations that fell in it alone (the last slot: above every bound); summed on write. */
  readonly counts: Float64Array;
  sum = 0;
  count = 0;
  constructor(readonly bounds: readonly number[]) {
    this.counts = new Float64Array(bounds.length + 1);
  }

  observe(v: number) {
    const b = this.bounds;
    let i = 0;
    while (i < b.length && v > b[i]!) i++;
    this.counts[i]!++;
    this.sum += v;
    this.count++;
  }
}

export class HistogramFamily extends Family<Histogram> {
  constructor(
    name: string,
    help: string,
    labelNames: readonly string[],
    readonly bounds: readonly number[],
  ) {
    super(name, help, "histogram", labelNames);
    for (let i = 1; i < bounds.length; i++)
      if (!(bounds[i]! > bounds[i - 1]!)) throw new Error(`${name}: bucket bounds must increase`);
    if (labelNames.includes("le")) throw new Error(`${name}: "le" is the histogram's own label`);
  }
  protected make() {
    return new Histogram(this.bounds);
  }
  write(out: string[]) {
    for (const { values, child } of this.children.values()) {
      // Each `le` bucket counts every observation at or below its bound: cumulative, `+Inf` the total.
      let cumulative = 0;
      for (let i = 0; i < this.bounds.length; i++) {
        cumulative += child.counts[i]!;
        const le = `le="${formatValue(this.bounds[i]!)}"`;
        out.push(`${this.name}_bucket${labelSet(this.labelNames, values, le)} ${formatValue(cumulative)}`);
      }
      out.push(`${this.name}_bucket${labelSet(this.labelNames, values, 'le="+Inf"')} ${formatValue(child.count)}`);
      out.push(`${this.name}_sum${labelSet(this.labelNames, values)} ${formatValue(child.sum)}`);
      out.push(`${this.name}_count${labelSet(this.labelNames, values)} ${formatValue(child.count)}`);
    }
  }
}

/** A counter or gauge whose samples are read when scraped. */
class CollectedFamily extends Family<never> {
  constructor(
    name: string,
    help: string,
    type: "counter" | "gauge",
    labelNames: readonly string[],
    private readonly collect: () => number | Iterable<Sample>,
  ) {
    super(name, help, type, labelNames);
  }
  protected make(): never {
    throw new Error(`${this.name} is collected, not recorded`);
  }
  write(out: string[]) {
    const got = this.collect();
    const samples: Iterable<Sample> = typeof got === "number" ? [[[], got]] : got;
    for (const [values, v] of samples) out.push(`${this.name}${labelSet(this.labelNames, values)} ${formatValue(v)}`);
  }
}

export class Registry {
  private readonly families = new Map<string, Family<unknown>>();

  private add<F extends Family<unknown>>(f: F): F {
    if (!METRIC_NAME.test(f.name)) throw new Error(`invalid metric name ${f.name}`);
    for (const l of f.labelNames)
      if (!LABEL_NAME.test(l) || l.startsWith("__")) throw new Error(`${f.name}: invalid label name ${l}`);
    if (this.families.has(f.name)) throw new Error(`metric ${f.name} registered twice`);
    this.families.set(f.name, f);
    return f;
  }

  counter(name: string, help: string, labelNames: readonly string[] = []): CounterFamily {
    return this.add(new CounterFamily(name, help, "counter", labelNames));
  }

  histogram(name: string, help: string, bounds: readonly number[], labelNames: readonly string[] = []) {
    return this.add(new HistogramFamily(name, help, labelNames, bounds));
  }

  /** A counter read when scraped (a count kept elsewhere: it must only grow). */
  collectedCounter(name: string, help: string, collect: () => number): void;
  collectedCounter(name: string, help: string, collect: () => Iterable<Sample>, labelNames: readonly string[]): void;
  collectedCounter(
    name: string,
    help: string,
    collect: () => number | Iterable<Sample>,
    labelNames: readonly string[] = [],
  ) {
    this.add(new CollectedFamily(name, help, "counter", labelNames, collect));
  }

  /** A gauge read when scraped. */
  gauge(name: string, help: string, collect: () => number): void;
  gauge(name: string, help: string, collect: () => Iterable<Sample>, labelNames: readonly string[]): void;
  gauge(name: string, help: string, collect: () => number | Iterable<Sample>, labelNames: readonly string[] = []) {
    this.add(new CollectedFamily(name, help, "gauge", labelNames, collect));
  }

  /** The text exposition format 0.0.4: each family's HELP and TYPE, then its samples. */
  encode(): string {
    const out: string[] = [];
    for (const f of this.families.values()) {
      out.push(`# HELP ${f.name} ${escapeHelp(f.help)}`);
      out.push(`# TYPE ${f.name} ${f.type}`);
      f.write(out);
    }
    return out.length ? `${out.join("\n")}\n` : "";
  }
}
