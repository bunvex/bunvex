// Generated programs on Convex's backend and on bunvex's (STUDY-122 phase 2): fast-check builds them (writes,
// reads inside the mutation, queries, pages), both backends play each from empty tables, and every answer and
// the final data must match. A difference is shrunk to a small program, written to
// .cache/failures/last.json (the program and the differences, ready to become a fixed test), and fails the
// test with fast-check's seed. DIFF_RUNS sets how many programs (default 25), DIFF_SEED replays a run.
// Skipped, with a note, when Convex's backend is not there.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { type Backend, ORACLE_BIN, startBunvex, startConvex } from "../harness/backends.ts";
import { programArb } from "../harness/generate.ts";
import { compare } from "../harness/runner.ts";

const ready = existsSync(ORACLE_BIN);
if (!ready) console.warn(`differential: skipped, no Convex backend at ${ORACLE_BIN}`);

const RUNS = Number(process.env.DIFF_RUNS ?? 25);
const SEED = process.env.DIFF_SEED === undefined ? undefined : Number(process.env.DIFF_SEED);
const FAILURES = join(import.meta.dir, "../.cache/failures");

describe.skipIf(!ready)("generated programs on Convex and on bunvex", () => {
  let oracle: Backend;
  let bunvex: Backend;
  beforeAll(async () => {
    [oracle, bunvex] = await Promise.all([startConvex(), startBunvex()]);
  }, 120_000);
  afterAll(async () => {
    await Promise.all([oracle?.stop(), bunvex?.stop()]);
  });

  test(
    "every answer and the final data match",
    async () => {
      await fc.assert(
        fc.asyncProperty(programArb(), async (program) => {
          const diffs = await compare(oracle, bunvex, program, { reset: true });
          if (diffs.length) {
            // The last one written is the smallest: fast-check shrinks toward it.
            mkdirSync(FAILURES, { recursive: true });
            writeFileSync(join(FAILURES, "last.json"), `${JSON.stringify({ program, diffs }, null, 2)}\n`);
          }
          expect(diffs).toEqual([]);
        }),
        { numRuns: RUNS, ...(SEED === undefined ? {} : { seed: SEED }), endOnFailure: false },
      );
    },
    30 * 60_000,
  );
});
