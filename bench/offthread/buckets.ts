// STUDY-190: where the main thread's time goes, from a `bun --cpu-prof` profile (.cpuprofile, Chrome's format).
// Every sample is put in one bucket by its stack, so the buckets add up to the thread's sampled time:
//   - "store write" / "store read": any frame in a persistence driver (core/src/persistence, packages/persistence),
//     a write when the stack holds the committer's apply/flush, the document log or a prune;
//   - "values": the nearest app-side frame is in packages/values (checks, toJson/fromJson, sizes);
//   - "request path": the nearest frame is in packages/server/src, split by file (cors, function log, metrics, …);
//   - "engine": packages/core/src outside the drivers (transactions, query cache, committer, shapes, schema);
//   - "function": the bench's own functions (bench/functions.ts);
//   - "prototype: thread messages": a prototype's own code (bench/offthread/), posting to and answering threads;
//   - "runtime (no JS caller)": native frames with no JS frame above them: Bun's HTTP serving, `Response`, timers;
//   - "gc" and "idle/program" as the profiler names them.
// A native leaf (JSON.parse, `byteLength`, a statement's `run`) goes to its nearest JS caller's bucket, and is
// listed under it.
//   bun bench/offthread/buckets.ts <file.cpuprofile> [requests] [--top N] [--after-gap ms]
import { readFileSync } from "node:fs";

type CallFrame = { functionName: string; url: string; lineNumber: number };
type Node = { id: number; callFrame: CallFrame; children?: number[]; parent?: number };
type Profile = { nodes: Node[]; samples: number[]; timeDeltas: number[]; startTime: number; endTime: number };

export type Bucketed = {
  totalMs: number;
  wallMs: number;
  buckets: Map<string, { ms: number; leaves: Map<string, number> }>;
};

const WRITE_FNS =
  /^(apply|flush|writeIndexEntries|readDocumentLog|pruneIndexes|pruneDocuments|setGlobal|writeBatchOf|flushWithRetries)$/;

function fileOf(url: string): string {
  const m = url.match(/(packages\/[^/]+\/src\/.*|bench\/.*)$/);
  return m ? m[1]! : url;
}

function requestPathPart(file: string): string {
  const f = file.replace(/^packages\/server\/src\//, "");
  if (/^cors/.test(f)) return "request path: CORS";
  if (/^(function-log|logs|log|log-events|log-sinks|logs-)/.test(f)) return "request path: function log";
  if (/(metrics|prometheus|usage-|tracing|request-tracing)/.test(f)) return "request path: metrics and tracing";
  if (/^(json-body|http-body|value-format|result-snapshot|web-response)/.test(f))
    return "request path: body parse and result encoding";
  if (/^(server|router|request-limit|request-timeout|client-version|admin-keys|auth-info)/.test(f))
    return "request path: routing and server";
  if (/^(functions|function-path|function-executor|registration|query-args|system-args|code-version)/.test(f))
    return "request path: function dispatch";
  if (/^(sync|data-sync)/.test(f)) return "request path: sync";
  return `request path: other (${f})`;
}

/** `afterGapMs`: samples before the first idle gap of at least this long are left out (the server's start and
 *  its background catch-up, which profile.ts waits out before the load starts). */
export function bucketize(profile: Profile, afterGapMs = 0): Bucketed {
  const byId = new Map<number, Node>();
  for (const n of profile.nodes) byId.set(n.id, n);
  for (const n of profile.nodes) for (const c of n.children ?? []) byId.get(c)!.parent = n.id;
  const memo = new Map<number, { bucket: string; leaf: string }>();
  const classify = (id: number): { bucket: string; leaf: string } => {
    const hit = memo.get(id);
    if (hit) return hit;
    const leafNode = byId.get(id)!;
    const leaf = `${leafNode.callFrame.functionName || "(anonymous)"}${leafNode.callFrame.url ? "" : " [native]"}`;
    let result: { bucket: string; leaf: string } | undefined;
    const name = leafNode.callFrame.functionName;
    if (name === "(garbage collector)") result = { bucket: "gc", leaf };
    else if (name === "(idle)" || name === "(program)" || name === "(root)") result = { bucket: "idle/program", leaf };
    if (!result) {
      // The stack, leaf first.
      const stack: Node[] = [];
      for (let n: Node | undefined = leafNode; n; n = n.parent === undefined ? undefined : byId.get(n.parent))
        stack.push(n);
      const files = stack.map((n) => fileOf(n.callFrame.url));
      const inDriver = files.some((f) => /^packages\/(core\/src\/persistence|persistence\/src)\//.test(f));
      if (inDriver) {
        const write = stack.some(
          (n, i) => WRITE_FNS.test(n.callFrame.functionName) && /(persistence|committer)/.test(files[i]!),
        );
        result = { bucket: write ? "store write" : "store read", leaf };
      } else {
        const nearest = files.find((f) => /^(packages|bench)\//.test(f));
        if (nearest === undefined) result = { bucket: "runtime (no JS caller)", leaf };
        else if (nearest.startsWith("packages/values/")) result = { bucket: "values", leaf };
        else if (nearest.startsWith("packages/server/")) result = { bucket: requestPathPart(nearest), leaf };
        else if (nearest.startsWith("packages/core/")) {
          const f = nearest.replace(/^packages\/core\/src\//, "");
          const part = /^committer/.test(f)
            ? "engine: committer"
            : /^(query-cache|read-set-index|read-count|index-cache)/.test(f)
              ? "engine: caches and read sets"
              : /^(shapes|schema|schema-validations|validator-subset|table-summar)/.test(f)
                ? "engine: schema and shapes"
                : "engine: transactions";
          result = { bucket: part, leaf };
        } else if (nearest.startsWith("bench/offthread/")) result = { bucket: "prototype: thread messages", leaf };
        else if (nearest.startsWith("bench/")) result = { bucket: "function", leaf };
        else result = { bucket: `other (${nearest})`, leaf };
      }
    }
    memo.set(id, result);
    return result;
  };
  const buckets: Bucketed["buckets"] = new Map();
  let total = 0;
  let first = 0;
  if (afterGapMs > 0) {
    const gap = profile.timeDeltas.findIndex((d) => d / 1000 >= afterGapMs);
    if (gap >= 0) first = gap;
  }
  let skippedMs = 0;
  for (let i = 0; i < first; i++) skippedMs += (profile.timeDeltas[i] ?? 0) / 1000;
  // Each sample is one look at the stack: buckets are shares of the samples. The thread's busy time is the sum of
  // the gaps between samples, each capped at twice the interval: the sampler records nothing while the thread
  // waits in the event loop, so a longer gap is mostly idle (and on a loaded machine the sampler itself runs late).
  const interval = (profile.endTime - profile.startTime) / Math.max(1, profile.samples.length) / 1000;
  const cap = 2 * Math.min(1, interval || 1);
  const counts = new Map<string, { n: number; leaves: Map<string, number> }>();
  let samples = 0;
  for (let i = first; i < profile.samples.length; i++) {
    const dt = (profile.timeDeltas[i + 1] ?? profile.timeDeltas[i] ?? 0) / 1000;
    const { bucket, leaf } = classify(profile.samples[i]!);
    let b = counts.get(bucket);
    if (!b) {
      b = { n: 0, leaves: new Map() };
      counts.set(bucket, b);
    }
    b.n++;
    b.leaves.set(leaf, (b.leaves.get(leaf) ?? 0) + 1);
    samples++;
    total += Math.min(dt, cap);
  }
  for (const [name, b] of counts) {
    const leaves = new Map<string, number>();
    for (const [l, n] of b.leaves) leaves.set(l, (n / samples) * total);
    buckets.set(name, { ms: (b.n / samples) * total, leaves });
  }
  return { totalMs: total, wallMs: (profile.endTime - profile.startTime) / 1000 - skippedMs, buckets };
}

export function report(b: Bucketed, requests?: number, top = 3): string {
  const rows = [...b.buckets].sort((x, y) => y[1].ms - x[1].ms);
  const lines = [
    `main thread busy ${(b.totalMs / 1000).toFixed(2)} s of ${(b.wallMs / 1000).toFixed(2)} s` +
      (requests ? `, ${requests} requests, ${((b.totalMs * 1000) / requests).toFixed(1)} µs/request` : ""),
    `| bucket | share | ${requests ? "µs/request | " : ""}top leaves |`,
    `|---|---:|${requests ? "---:|" : ""}---|`,
  ];
  for (const [name, v] of rows) {
    const leaves = [...v.leaves]
      .sort((x, y) => y[1] - x[1])
      .slice(0, top)
      .map(([l, ms]) => `${l} ${((100 * ms) / b.totalMs).toFixed(1)}%`)
      .join(", ");
    lines.push(
      `| ${name} | ${((100 * v.ms) / b.totalMs).toFixed(1)}% | ${requests ? `${((v.ms * 1000) / requests).toFixed(1)} | ` : ""}${leaves} |`,
    );
  }
  return lines.join("\n");
}

if (import.meta.main) {
  const [file, req] = process.argv.slice(2);
  const top = process.argv.includes("--top") ? Number(process.argv[process.argv.indexOf("--top") + 1]) : 3;
  if (!file)
    throw new Error("usage: bun bench/offthread/buckets.ts <file.cpuprofile> [requests] [--top N] [--after-gap ms]");
  const p = JSON.parse(readFileSync(file, "utf8")) as Profile;
  const gap = process.argv.includes("--after-gap") ? Number(process.argv[process.argv.indexOf("--after-gap") + 1]) : 0;
  console.log(report(bucketize(p, gap), req && !req.startsWith("--") ? Number(req) : undefined, top));
}
