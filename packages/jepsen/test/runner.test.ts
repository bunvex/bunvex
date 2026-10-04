// The runner itself (STUDY-57 §3): faults that hit it outside the workload's window.
import { describe, expect, test } from "bun:test";
import { nemesisByName } from "../src/nemesis.ts";
import { describe as summary } from "../src/report.ts";
import { type Nemesis, run } from "../src/runner.ts";

describe("runner", () => {
  // Found by the coverage job (3 Oct 2026, the short run with faults timed out at 60 s, ~1% of seeds): a
  // store fault ended the server (a fatal flush during the starting state's mutation; a read error in the
  // crons' push at its start) before the nemesis ran, so nothing restarted it and the client waited for it
  // forever. The supervisor now runs while the starting state is written.
  test("a server that exits before the workload starts is restarted", async () => {
    const kill = nemesisByName("kill")!;
    const nemesis: Nemesis = {
      ...kill,
      name: "exit at start",
      async setup(ctx) {
        const url = await kill.setup!(ctx);
        await ctx.server.kill(); // as the fatal flush: the process is gone, no one has restarted it yet
        return url;
      },
    };
    const result = await run({ seed: 1, store: "memory", clients: 2, durationMs: 500, nemesis });
    if (!result.ok) console.error(summary(result));
    expect(result.violations).toEqual([]);
    expect(result.events[0]).toMatch(/server exited: restart/);
  }, 30_000);
});
