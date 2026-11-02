// The PERSIST-01 suite on the two embedded drivers, as part of `bun test`. The external drivers
// (Postgres, MySQL) run in their own CI job against service containers (bun bench/conformance.ts).
import { expect, test } from "bun:test";
import { runConformance } from "@bunvex/persistence-conformance";

for (const name of ["memory", "sqlite"]) {
  test(
    `PERSIST-01 conformance K1–K32: ${name}`,
    async () => {
      const lines: string[] = [];
      const { failures } = await runConformance({
        name,
        driverModule: `${import.meta.dir}/drivers/${name}.ts`,
        kills: 2,
        requireLease: true, // PERSIST-01 C7: an OS lock on the file (STUDY-25 L9)
        requireLayout: true, // PERSIST-01 C10: layout version and read-only flag (STUDY-25 L6/L7)
        requireVersions: true, // PERSIST-01 C16
        log: (l) => lines.push(l),
      });
      expect(lines.filter((l) => l.startsWith("FAIL"))).toEqual([]);
      expect(failures).toBe(0);
    },
    { timeout: 300_000 },
  );
}

// STUDY-194 §10.2 (2b step ii): the reads an execution worker makes, on its own read-only connection, in a Worker,
// against the store the main thread writes: the checks that read (K1, K2, K8, K9) and those that run engines on it
// (K3–K5, K24).
test(
  "PERSIST-01 conformance, reads through a Worker's reader: sqlite",
  async () => {
    const lines: string[] = [];
    const { failures } = await runConformance({
      name: "sqlite-worker-reads",
      driverModule: `${import.meta.dir}/drivers/sqlite-worker-reads.ts`,
      checks: ["K1", "K2", "K3", "K8", "K9", "K24"],
      requireLease: true,
      log: (l) => lines.push(l),
    });
    expect(lines.filter((l) => l.startsWith("FAIL"))).toEqual([]);
    expect(lines.filter((l) => l.startsWith("ok")).length).toBeGreaterThanOrEqual(10);
    expect(failures).toBe(0);
  },
  { timeout: 300_000 },
);
