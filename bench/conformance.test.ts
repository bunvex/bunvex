// The PERSIST-01 suite on the two embedded drivers, as part of `bun test`. The external drivers
// (Postgres, MySQL, MongoDB) run in their own CI job against service containers (bun bench/conformance.ts).
import { expect, test } from "bun:test";
import { runConformance } from "@bunvex/persistence-conformance";

for (const name of ["memory", "sqlite"]) {
  test(
    `PERSIST-01 conformance K1–K31: ${name}`,
    async () => {
      const lines: string[] = [];
      const { failures } = await runConformance({
        name,
        driverModule: `${import.meta.dir}/drivers/${name}.ts`,
        kills: 2,
        requireLease: true, // PERSIST-01 C7: an OS lock on the file (STUDY-25 L9)
        requireLayout: true, // PERSIST-01 C10: layout version and read-only flag (STUDY-25 L6/L7)
        requireReadLog: true, // PERSIST-01 C11
        log: (l) => lines.push(l),
      });
      expect(lines.filter((l) => l.startsWith("FAIL"))).toEqual([]);
      expect(failures).toBe(0);
    },
    { timeout: 300_000 },
  );
}
