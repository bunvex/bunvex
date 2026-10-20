// The soak's memory probe (STUDY-174 F6), preloaded into the backend by `soak.ts --probe` (`bun --preload`). Every
// SOAK_PROBE_SECONDS (default 15) it appends one JSON line to SOAK_PROBE_OUT: process.memoryUsage(), JSC's heapStats
// (with every object type's count), Bun's memory footprint and /proc/self/smaps_rollup. Every SOAK_PROBE_GC_MINUTES
// (default 10) it forces a full GC first, and marks that sample. Touch `<out>.snap` for a heap snapshot,
// `<out>.mimalloc` for mimalloc's stats on stderr, and `<out>.smaps` for a copy of /proc/self/smaps.

import { heapStats } from "bun:jsc";
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const out = process.env.SOAK_PROBE_OUT;
if (out) {
  const every = Number(process.env.SOAK_PROBE_SECONDS ?? 15) * 1000;
  const gcEvery = Number(process.env.SOAK_PROBE_GC_MINUTES ?? 10) * 60_000;
  const t0 = Date.now();
  let lastGc = t0;
  let snaps = 0;
  const rollup = () => {
    try {
      const text = readFileSync("/proc/self/smaps_rollup", "utf8");
      const r: Record<string, number> = {};
      for (const m of text.matchAll(/^(\w+):\s+(\d+) kB/gm)) r[m[1]!] = Number(m[2]) * 1024;
      return r;
    } catch {
      return null;
    }
  };
  const sample = () => {
    let gc = false;
    if (gcEvery > 0 && Date.now() - lastGc >= gcEvery) {
      Bun.gc(true);
      lastGc = Date.now();
      gc = true;
    }
    const hs = heapStats();
    const unsafe = Bun.unsafe as unknown as { memoryFootprint?: () => number; mimallocDump?: () => void };
    const line = {
      t: (Date.now() - t0) / 1000,
      gc,
      mu: process.memoryUsage(),
      hs: {
        heapSize: hs.heapSize,
        heapCapacity: hs.heapCapacity,
        extraMemorySize: hs.extraMemorySize,
        objectCount: hs.objectCount,
        protectedObjectCount: hs.protectedObjectCount,
        globalObjectCount: hs.globalObjectCount,
        protectedGlobalObjectCount: hs.protectedGlobalObjectCount,
        objectTypeCounts: hs.objectTypeCounts,
        protectedObjectTypeCounts: hs.protectedObjectTypeCounts,
      },
      footprint: unsafe.memoryFootprint?.() ?? null,
      smaps: rollup(),
    };
    appendFileSync(out, `${JSON.stringify(line)}\n`);
    if (existsSync(`${out}.mimalloc`)) {
      rmSync(`${out}.mimalloc`);
      console.error(`---- mimalloc at t=${line.t}s ----`);
      unsafe.mimallocDump?.();
    }
    if (existsSync(`${out}.smaps`)) {
      rmSync(`${out}.smaps`);
      try {
        writeFileSync(`${out}.smaps-${Math.round(line.t)}s.txt`, readFileSync("/proc/self/smaps", "utf8"));
      } catch {}
    }
    // Last: a snapshot allocates hundreds of MB for a moment, which would show in the two dumps above.
    if (existsSync(`${out}.snap`)) {
      rmSync(`${out}.snap`);
      Bun.gc(true);
      writeFileSync(`${out}.heap-${++snaps}-${Math.round(line.t)}s.json`, JSON.stringify(Bun.generateHeapSnapshot()));
    }
  };
  setInterval(sample, every).unref();
}
