// A conformance child that exits before it prints `start` fails the suite at once, with its exit status and
// stderr, instead of leaving the parent waiting for a line that never comes (until the test's timeout).
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Check, runConformance } from "../src/index.ts";

const dir = mkdtempSync(join(tmpdir(), "bunvex-child-start-"));
process.env.DIR = dir;
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const driverModule = `${import.meta.dir}/fixtures/crashing-driver.ts`;

// K6 spawns child.ts, K26 batch-child.ts, K10 (K13, K19) lease-child.ts.
for (const [check, script] of [
  ["K6", "child.ts"],
  ["K26", "batch-child.ts"],
  ["K10", "lease-child.ts"],
] as [Check, string][]) {
  test(`${check}: a child (${script}) that dies before "start" fails the suite at once, quoting its stderr`, async () => {
    const t0 = Date.now();
    const err = await runConformance({ name: "crashing", driverModule, checks: [check], kills: 1, log: () => {} }).then(
      () => null,
      (e: Error) => e,
    );
    const took = Date.now() - t0;
    expect(err?.message).toContain(`the conformance child ${script} exited (code 7) before printing "start"`);
    expect(err?.message).toContain("crashing-driver: refusing to open in a child process");
    expect(took).toBeLessThan(10_000);
  }, 30_000);
}
