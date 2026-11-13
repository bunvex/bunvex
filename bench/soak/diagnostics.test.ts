// The soak's latency diagnostics (./diagnostics.ts) on made-up /proc text and samples: what each window's CPU and
// stalls come to, and how the report sets the slow windows against the others.
import { describe, expect, test } from "bun:test";
import {
  hostShares,
  loopWindow,
  parseProcStat,
  slowWindows,
  statTicks,
  type ThreadTicks,
  threadCores,
} from "./diagnostics.ts";
import type { Sample } from "./rules.ts";

describe("the machine's CPU (/proc/stat)", () => {
  // user nice system idle iowait irq softirq steal guest guest_nice
  const before = "cpu  1000 0 500 8000 100 0 0 400 0 0\ncpu0 250 0 125 2000 25 0 0 100 0 0\nintr 1\n";
  const after = "cpu  1100 10 590 8100 150 5 5 540 0 0\ncpu0 1 1 1 1 1 1 1 1 0 0\nintr 2\n";

  test("parses the all-CPU line, not a per-CPU one", () => {
    expect(parseProcStat(before)).toEqual({ busy: 1500, iowait: 100, steal: 400, total: 10000 });
  });

  test("a window's shares of the machine's time", () => {
    // 500 ticks: busy 100+10+90+5+5 = 210, iowait 50, steal 140, idle 100
    expect(hostShares(parseProcStat(before)!, parseProcStat(after)!)).toEqual({
      hostBusy: 0.42,
      hostIowait: 0.1,
      hostSteal: 0.28,
    });
  });

  test("no all-CPU line, or a short one, is no reading", () => {
    expect(parseProcStat("cpu0 1 2 3 4 5 6 7 8\n")).toBeNull();
    expect(parseProcStat("cpu  1 2 3\n")).toBeNull();
  });

  test("an empty window is no share", () => {
    const t = parseProcStat(before)!;
    expect(hostShares(t, t)).toEqual({ hostBusy: 0, hostIowait: 0, hostSteal: 0 });
  });
});

describe("a thread's CPU (/proc/<pid>/task/<tid>/stat)", () => {
  test("utime + stime, counted past a name with spaces and parentheses", () => {
    // pid (comm) state ppid pgrp session tty tpgid flags minflt cminflt majflt cmajflt utime stime …
    expect(statTicks("42 (JSC (Heap) 1) S 1 42 42 0 -1 4194560 10 0 0 0 1234 56 0 0 20 0")).toBe(1290);
  });

  test("cores per thread name: same names summed, a new thread from zero, an ended one gone", () => {
    const a: ThreadTicks = new Map([
      [1, { comm: "bun", ticks: 1000 }],
      [2, { comm: "HeapHelper", ticks: 100 }],
      [3, { comm: "HeapHelper", ticks: 100 }],
      [4, { comm: "gone", ticks: 500 }],
    ]);
    const b: ThreadTicks = new Map([
      [1, { comm: "bun", ticks: 2500 }],
      [2, { comm: "HeapHelper", ticks: 250 }],
      [3, { comm: "HeapHelper", ticks: 400 }],
      [5, { comm: "new", ticks: 30 }],
      [6, { comm: "idle", ticks: 0 }],
    ]);
    // 15 s at 100 ticks a second: bun 1500 ticks = 1 core, HeapHelper 450 = 0.3, new 30 = 0.02
    expect(threadCores(a, b, 15)).toEqual({ bun: 1, HeapHelper: 0.3, new: 0.02 });
    expect(Object.keys(threadCores(a, b, 15))).toEqual(["bun", "HeapHelper", "new"]);
  });
});

describe("the main thread's stalls (./loop-lag.ts lines)", () => {
  const lines = "1000 25\n2000 240\n2500 30\n3000 60\n\n";

  test("the stalls inside (from, to], summed, and the longest", () => {
    expect(loopWindow(lines, 1000, 2500)).toEqual({ maxMs: 240, stalls: 2, stalledMs: 270 });
    expect(loopWindow(lines, 0, 1000)).toEqual({ maxMs: 25, stalls: 1, stalledMs: 25 });
  });

  test("none in the window, or no file yet", () => {
    expect(loopWindow(lines, 3000, 9000)).toEqual({ maxMs: 0, stalls: 0, stalledMs: 0 });
    expect(loopWindow("", 0, 9000)).toEqual({ maxMs: 0, stalls: 0, stalledMs: 0 });
  });
});

describe("the report's slow windows", () => {
  const sample = (t: number, p99: number, steal: number, stall: number, gc: number): Sample => ({
    t,
    rssBytes: 0,
    heapBytes: 0,
    indexCacheBytes: 0,
    fds: 0,
    cacheHits: 0,
    cacheMisses: 0,
    sessions: 0,
    subscriptions: 0,
    roomMembers: 0,
    clients: 0,
    subscriptionsOpen: 0,
    recentReconnects: 0,
    latency: { "http query": { p50: 1, p99, n: 300 } },
    eventLoopLagSeconds: 0,
    backlogSeconds: 0,
    cpu: {
      hostBusy: 0.5,
      hostIowait: 0.01,
      hostSteal: steal,
      backendCores: 1,
      driverCores: 0.5,
      threads: { bun: 0.8, HeapHelper: gc },
    },
    loop: { maxMs: stall, stalls: stall ? 1 : 0, stalledMs: stall },
  });

  test("the slow windows' medians against the others'", () => {
    const md = slowWindows(
      [
        sample(0, 10, 0.01, 0, 0.1),
        sample(15, 200, 0.3, 150, 0.9),
        sample(30, 12, 0.02, 0, 0.1),
        sample(45, 180, 0.2, 130, 0.7),
      ],
      "http query",
    ).join("\n");
    expect(md).toContain("| slow (2) | 190 ms | 25.0 % | 1.0 % | 50.0 % | 1.00 | 0.50 | 140 ms | 140 ms |");
    expect(md).toContain("| others (2) | 11 ms | 1.5 % | 1.0 % | 50.0 % | 1.00 | 0.50 | 0 ms | 0 ms |");
    expect(md).toContain("slow windows bun 0.80, HeapHelper 0.80; others bun 0.80, HeapHelper 0.10.");
  });

  test("nothing slow, nothing reported; no CPU reading shows as a dash", () => {
    expect(slowWindows([sample(0, 10, 0, 0, 0)], "http query")).toEqual([]);
    const off = { ...sample(0, 300, 0, 0, 0), cpu: null, loop: null };
    expect(slowWindows([off], "http query").join("\n")).toContain("| slow (1) | 300 ms | — | — | — | — | — | — | — |");
  });
});
