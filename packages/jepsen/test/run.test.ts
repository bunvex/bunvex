// The short run every PR's CI does (STUDY-57 §5, the owner's call): a few seconds of the workload on the two
// embedded stores, a new seed each time (printed with any failure, so it reproduces). JEPSEN_SEED pins it.
import { describe, expect, test } from "bun:test";
import { describe as summary } from "../src/report.ts";
import { nemesisByName } from "../src/nemesis.ts";
import { run } from "../src/runner.ts";

const seed = Number(process.env.JEPSEN_SEED ?? Math.floor(Math.random() * 2 ** 31));

describe("Jepsen-style short run", () => {
  for (const store of ["memory", "sqlite"])
    test(`${store}: linearizable registers, bank invariant, set and log exactly-once, read-your-writes, snapshots`, async () => {
      const result = await run({ seed, store, clients: 5, durationMs: 1500 });
      if (!result.ok) console.error(summary(result));
      expect({ seed, store, violations: result.violations }).toEqual({ seed, store, violations: [] });
      // the run did real work: thousands of operations, every kind of them
      expect(result.stats.ops).toBeGreaterThan(500);
      expect(Object.keys(result.stats.byFunction).length).toBe(7);
    }, 60_000);

  // faults too (STUDY-57 §4): connections cut, the server killed and restarted, the store slow and failing
  test("memory, with faults: the same checks hold", async () => {
    const result = await run({ seed, store: "memory", clients: 5, durationMs: 2500, nemesis: nemesisByName("all") });
    if (!result.ok) console.error(summary(result));
    expect({ seed, violations: result.violations }).toEqual({ seed, violations: [] });
    expect(result.events.length).toBeGreaterThan(0);
    expect(result.stats.ops).toBeGreaterThan(100);
  }, 60_000);
});
