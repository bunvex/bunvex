// The crash child for K6: opens the driver module given on the command line and commits continuously
// from 16 concurrent writers, printing every acknowledged ts, until it is SIGKILLed.
//   bun child.ts <absolute path of the driver module>

import type { DriverModule } from "./index.ts";
import { insertItem, newEngine } from "./workload.ts";

const mod = (await import(process.argv[2])) as DriverModule;
const p = await mod.open(false);
const e = await newEngine(p);
console.log(`start ${e.committer.visibleTs}`);
await Promise.all(
  Array.from({ length: 16 }, async (_, w) => {
    for (;;) {
      await e.mutation(insertItem(`t${w}`));
      console.log(`ack ${e.committer.visibleTs}`);
    }
  }),
);
