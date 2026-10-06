// The crash child for K26: commits continuously from 64 writers with ~2 KiB documents, so the committer splits
// its groups into several write batches (DV-62), until it is SIGKILLed. Before each flush it announces the
// timestamps that flush carries (synchronously, so the line is in the pipe before anything is written), and
// it prints every acknowledged ts.
//   bun batch-child.ts <absolute path of the driver module>
import { writeSync } from "node:fs";
import type { DriverModule } from "./index.ts";
import { insertPadded, newEngine } from "./workload.ts";

const mod = (await import(process.argv[2])) as DriverModule;
const inner = await mod.open(false);
let applied: bigint[] = [];
const say = (line: string) => writeSync(1, `${line}\n`);
const p = new Proxy(inner, {
  get(t, k) {
    if (k === "apply")
      return (ts: bigint, docs: never, idx: never) => {
        applied.push(ts);
        return t.apply(ts, docs, idx);
      };
    if (k === "flush")
      return () => {
        if (applied.length) say(`flush ${applied.join(",")}`);
        applied = [];
        return t.flush();
      };
    const v = Reflect.get(t, k, t);
    return typeof v === "function" ? v.bind(t) : v;
  },
});
const e = await newEngine(p, { lease: { ttlMs: Number(process.env.LEASE_TTL_MS ?? 1000) } });
say(`start ${e.committer.visibleTs}`);
await Promise.all(
  Array.from({ length: 64 }, async (_, w) => {
    for (let n = 0; ; n++) {
      await e.mutation(insertPadded(`t${w}`, 1, 2000, n));
      say(`ack ${e.committer.visibleTs} ${e.committer.batches} ${e.committer.groups}`);
    }
  }),
);
