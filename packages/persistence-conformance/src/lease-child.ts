// The stale writer for K13: holds the store's lease (short TTL) and commits continuously, printing every
// acknowledged ts. The parent SIGSTOPs it, takes the store over, and SIGCONTs it: it must then stop with a
// lost lease (exit 3), never landing a write.
//   LEASE_TTL_MS=… bun lease-child.ts <absolute path of the driver module>

import { CommitterStoppedError, LeaseLostError } from "@bunvex/core";
import type { DriverModule } from "./index.ts";
import { insertItem, newEngine } from "./workload.ts";

const mod = (await import(process.argv[2])) as DriverModule;
const e = await newEngine(await mod.open(false), { lease: { ttlMs: Number(process.env.LEASE_TTL_MS ?? 1000) } });
e.committer.onFatal((err) => {
  console.log(err.cause instanceof LeaseLostError ? "lost" : `fatal ${err.message}`);
  process.exit(err.cause instanceof LeaseLostError ? 3 : 4);
});
console.log(`start ${e.committer.visibleTs}`);
await Promise.all(
  Array.from({ length: 8 }, async () => {
    for (;;) {
      try {
        await e.mutation(insertItem("child"));
        console.log(`ack ${e.committer.visibleTs}`);
      } catch (err) {
        if (err instanceof CommitterStoppedError) await new Promise(() => {}); // onFatal exits
        throw err;
      }
    }
  }),
);
