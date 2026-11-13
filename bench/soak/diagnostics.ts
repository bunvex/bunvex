// The soak's latency diagnostics: what held the backend when a window was slow. Never judged: the rules
// (./rules.ts) say that a latency trended up; these say whether the machine (another tenant's CPU, the disk) or the
// backend (its main thread held, one of its threads busy) was behind it. Pure functions over what soak.ts reads
// from /proc and from ./loop-lag.ts, so they are tested on their own (diagnostics.test.ts).

import { median, type Sample } from "./rules.ts";

/** The machine's CPU time since boot (the `cpu` line of /proc/stat), in clock ticks. */
export type HostTicks = { busy: number; iowait: number; steal: number; total: number };

/** The `cpu` line of /proc/stat: user nice system idle iowait irq softirq steal (guest time is inside user). */
export function parseProcStat(text: string): HostTicks | null {
  const line = text.split("\n").find((l) => l.startsWith("cpu "));
  if (!line) return null;
  const f = line.trim().split(/\s+/).slice(1, 9).map(Number);
  if (f.length < 8 || f.some((n) => !Number.isFinite(n))) return null;
  const [user = 0, nice = 0, system = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0] = f;
  const busy = user + nice + system + irq + softirq;
  return { busy, iowait, steal, total: busy + idle + iowait + steal };
}

/** A process's or a thread's CPU time (utime + stime) from its /proc `stat`, in clock ticks. */
export function statTicks(stat: string): number {
  // The name, in parentheses, may hold spaces: the fields after it are counted from its closing one.
  const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return Number(f[11]) + Number(f[12]);
}

/** One window's CPU: shares of the machine's time (0–1), and cores (1 = one core busy all the window). */
export type WindowCpu = {
  hostBusy: number;
  hostIowait: number;
  /** Time the hypervisor gave another tenant while this machine wanted to run. */
  hostSteal: number;
  backendCores: number;
  /** The soak's own process (the clients and the HTTP calls run on the same machine). */
  driverCores: number;
  /** The backend's threads, summed by name (`comm`): cores each, above 0.005. */
  threads: Record<string, number>;
};

export function hostShares(a: HostTicks, b: HostTicks): Pick<WindowCpu, "hostBusy" | "hostIowait" | "hostSteal"> {
  const total = b.total - a.total;
  const share = (x: number) => (total > 0 ? round(x / total) : 0);
  return {
    hostBusy: share(b.busy - a.busy),
    hostIowait: share(b.iowait - a.iowait),
    hostSteal: share(b.steal - a.steal),
  };
}

/** A thread at one sample: its name and its CPU ticks so far. */
export type ThreadTicks = Map<number, { comm: string; ticks: number }>;

/**
 * Cores per thread name over `seconds`. A thread that started in the window counts from zero; one that ended is
 * gone from `b` and counts nothing (its last ticks are lost, a window's worth at most).
 */
export function threadCores(a: ThreadTicks, b: ThreadTicks, seconds: number, hz = 100): Record<string, number> {
  const by = new Map<string, number>();
  for (const [tid, t] of b) {
    const d = t.ticks - (a.get(tid)?.ticks ?? 0);
    if (d > 0) by.set(t.comm, (by.get(t.comm) ?? 0) + d);
  }
  const out: Record<string, number> = {};
  for (const [comm, d] of [...by].sort((x, y) => y[1] - x[1])) {
    const cores = d / hz / seconds;
    if (cores > 0.005) out[comm] = round(cores);
  }
  return out;
}

/** The main thread's stalls in one window, from ./loop-lag.ts's lines. */
export type WindowLoop = { maxMs: number; stalls: number; stalledMs: number };

/** The stalls of `lines` (`<epoch ms> <ms late>` each) that ran in (fromMs, toMs]. */
export function loopWindow(lines: string, fromMs: number, toMs: number): WindowLoop {
  const w: WindowLoop = { maxMs: 0, stalls: 0, stalledMs: 0 };
  for (const line of lines.split("\n")) {
    const [at, late] = line.split(" ").map(Number);
    if (at === undefined || late === undefined || !(at > fromMs && at <= toMs)) continue;
    w.stalls++;
    w.stalledMs += late;
    w.maxMs = Math.max(w.maxMs, late);
  }
  return w;
}

/**
 * The report's diagnostics: the windows where `op`'s p99 was above `slowMs` against the others, each column the
 * median over its windows, and the backend's busiest threads in each. Markdown lines; none when nothing was slow.
 */
export function slowWindows(samples: Sample[], op: string, slowMs = 50): string[] {
  const withOp = samples.filter((s) => s.latency[op] != null);
  const slow = withOp.filter((s) => s.latency[op]!.p99 > slowMs);
  if (slow.length === 0) return [];
  const rest = withOp.filter((s) => s.latency[op]!.p99 <= slowMs);
  const col = (xs: Sample[], f: (s: Sample) => number | undefined, fmt: (n: number) => string) => {
    const v = xs.map(f).filter((n): n is number => n !== undefined);
    return v.length ? fmt(median(v)) : "—";
  };
  const pct = (n: number) => `${(100 * n).toFixed(1)} %`;
  const cores = (n: number) => n.toFixed(2);
  const ms = (n: number) => `${n.toFixed(0)} ms`;
  const row = (name: string, xs: Sample[]) =>
    `| ${name} (${xs.length}) | ${col(xs, (s) => s.latency[op]?.p99, ms)} | ${col(xs, (s) => s.cpu?.hostSteal, pct)} | ${col(xs, (s) => s.cpu?.hostIowait, pct)} | ${col(xs, (s) => s.cpu?.hostBusy, pct)} | ${col(xs, (s) => s.cpu?.backendCores, cores)} | ${col(xs, (s) => s.cpu?.driverCores, cores)} | ${col(xs, (s) => s.loop?.maxMs, ms)} | ${col(xs, (s) => s.loop?.stalledMs, ms)} |`;
  const busiest = (xs: Sample[]) => {
    const names = new Set(xs.flatMap((s) => Object.keys(s.cpu?.threads ?? {})));
    const by = [...names].map((n) => [n, median(xs.map((s) => s.cpu?.threads[n] ?? 0))] as const);
    const top = by.sort((a, b) => b[1] - a[1]).slice(0, 5);
    return top.length ? top.map(([n, c]) => `${n} ${c.toFixed(2)}`).join(", ") : "—";
  };
  return [
    `Windows where ${op}'s p99 was above ${slowMs} ms, against the others (medians per window; diagnostics, not judged):`,
    "",
    "| Windows | p99 | CPU steal | I/O wait | host busy | backend cores | driver cores | longest stall | stalled |",
    "|---|---|---|---|---|---|---|---|---|",
    row("slow", slow),
    row("others", rest),
    "",
    `Busiest backend threads (cores): slow windows ${busiest(slow)}; others ${busiest(rest)}.`,
    "",
  ];
}

const round = (n: number) => Math.round(n * 1000) / 1000;
