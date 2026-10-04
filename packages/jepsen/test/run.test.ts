// The short run every PR's CI does (STUDY-57 §5, the owner's call): a few seconds of the workload on the two
// embedded stores, a new seed each time (printed with any failure, so it reproduces). JEPSEN_SEED pins it.
import { describe, expect, test } from "bun:test";
import { nemesisByName } from "../src/nemesis.ts";
import { describe as summary } from "../src/report.ts";
import { type RunResult, run } from "../src/runner.ts";

const seed = Number(process.env.JEPSEN_SEED ?? Math.floor(Math.random() * 2 ** 31));

/** The workload's operations: what the runner's worker invokes (src/runner.ts). */
const FUNCTIONS = ["bank:all", "bank:transfer", "log:append", "reg:cas", "reg:read", "reg:write", "set:add"];

/**
 * The run did real work, whatever the runner's speed: a count of operations does not prove it (a run is
 * time-boxed, so a slow runner does fewer — 393 instead of thousands under the coverage job, #303), so
 * this checks what the checks need. Every client completed operations, operations of different clients
 * overlapped (the linearizability and snapshot checks have concurrency to judge), and, with `everyKind`,
 * every function of the workload succeeded at least once.
 */
function didRealWork(result: RunResult, clients: number, everyKind: boolean) {
  const ok = result.history.filter((op) => op.status === "ok");
  const perClient = Array.from({ length: clients }, (_, c) => ok.filter((op) => op.client === c).length);
  expect({ seed, clientsWithoutAnyOk: perClient.flatMap((n, c) => (n > 0 ? [] : [c])) }).toEqual({
    seed,
    clientsWithoutAnyOk: [],
  });
  const byStart = [...ok].sort((a, b) => a.start - b.start);
  let concurrent = false;
  let open = byStart[0];
  for (const op of byStart.slice(1)) {
    if (op.start < open.end && op.client !== open.client) {
      concurrent = true;
      break;
    }
    if (op.end > open.end) open = op;
  }
  expect({ seed, concurrent }).toEqual({ seed, concurrent: true });
  if (everyKind) {
    const kinds = new Set(ok.map((op) => op.f));
    expect({ seed, missing: FUNCTIONS.filter((f) => !kinds.has(f)) }).toEqual({ seed, missing: [] });
  }
}

describe("Jepsen-style short run", () => {
  for (const store of ["memory", "sqlite"])
    test(`${store}: linearizable registers, bank invariant, set and log exactly-once, read-your-writes, snapshots`, async () => {
      const result = await run({ seed, store, clients: 5, durationMs: 1500 });
      if (!result.ok) console.error(summary(result));
      expect({ seed, store, violations: result.violations }).toEqual({ seed, store, violations: [] });
      // the run did real work: every client, concurrently, every kind of operation
      didRealWork(result, 5, true);
      expect(Object.keys(result.stats.byFunction).sort()).toEqual(FUNCTIONS);
    }, 60_000);

  // faults too (STUDY-57 §4): connections cut, the server killed and restarted, the store slow and failing
  test("memory, with faults: the same checks hold", async () => {
    const result = await run({ seed, store: "memory", clients: 5, durationMs: 2500, nemesis: nemesisByName("all") });
    if (!result.ok) console.error(summary(result));
    expect({ seed, violations: result.violations }).toEqual({ seed, violations: [] });
    expect(result.events.length).toBeGreaterThan(0);
    // faults may starve a kind of operation on a slow runner; every client still got answers, concurrently
    didRealWork(result, 5, false);
  }, 60_000);
});

describe("quiesce", () => {
  // Bug 3 (3 Oct 2026): with no nemesis the quiesce bound ran from the start, so a run longer than it read
  // the final state while the workers still wrote, and reported their later writes as lost
  test("the final read waits for the workload's deadline, with no nemesis", async () => {
    const result = await run({ seed, store: "memory", clients: 3, durationMs: 2500, quiesceMs: 1000 });
    // every worker had stopped: none still had an operation in flight when the final state was read
    expect(result.history.filter((op) => op.end === Number.POSITIVE_INFINITY)).toEqual([]);
    if (!result.ok) console.error(summary(result));
    expect({ seed, violations: result.violations }).toEqual({ seed, violations: [] });
  }, 60_000);
});
