// STUDY-184 §5.6 on Convex's local backend (the oracle binary, SQLite): for each cell, a fresh backend with the app
// of `s184-invalidation-app/`, and bench/s184-invalidation.ts run against it (TARGET_URL, TARGET_PID). NS and FANOUTS
// choose the cells as in the bench; its other variables (COMMITS, SECS, WRITERS, …) pass through. Splaying is
// turned off as in the bench's own server (Convex reads the same knob, SUBSCRIPTION_INVALIDATION_DELAY_MULTIPLIER);
// SPLAY=1 keeps it.
//   bun packages/differential/scripts/s184-invalidation-oracle.ts
import { join } from "node:path";
import { runningBackends, startConvex } from "../harness/backends.ts";

const NS = (process.env.NS ?? "0,1000,10000,100000").split(",");
const FANOUTS = (process.env.FANOUTS ?? "one,1%,10%").split(",");
for (const n of NS)
  for (const fanout of n === "0" ? ["none"] : FANOUTS) {
    const backend = await startConvex({
      app: join(import.meta.dir, "../s184-invalidation-app"),
      env: process.env.SPLAY ? {} : { SUBSCRIPTION_INVALIDATION_DELAY_MULTIPLIER: "0" },
    });
    try {
      const pid = runningBackends().at(-1);
      if (pid === undefined) throw new Error("no backend process");
      const bench = Bun.spawn(["bun", join(import.meta.dir, "../../../bench/s184-invalidation.ts")], {
        stdout: "inherit",
        stderr: "inherit",
        env: { ...process.env, NS: n, FANOUTS: fanout, TARGET_URL: backend.url, TARGET_PID: String(pid) },
      });
      if ((await bench.exited) !== 0) process.exitCode = 1;
    } finally {
      await backend.stop();
    }
    // The cell's sockets sit in TIME_WAIT (30 s on macOS) and hold their ephemeral ports.
    if (Number(n) >= 50_000) await Bun.sleep(35_000);
  }
