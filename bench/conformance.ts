// Runs @bunvex/persistence-conformance (PERSIST-01, K1–K33) against every first-party driver.
//   bun bench/conformance.ts                    memory + sqlite (+ postgres/mysql/mongodb when their URL is set)
//   DRIVERS=sqlite,postgres PG_URL=… bun bench/conformance.ts
//   KILLS=8 (K6 cycles)   CHECKS=K1,K2,K3,K6,K7,K20,K22 (subset; K3 covers K3–K5, K10 covers K10–K19, K30 covers K30–K31)
// Remote drivers need an EMPTY scratch database: the suite drops its tables. Exit code 1 on any violation.
import { type Check, runConformance } from "@bunvex/persistence-conformance";

const available = ["memory", "sqlite"];
if (process.env.PG_URL) available.push("postgres");
if (process.env.MYSQL_URL) available.push("mysql");
if (process.env.MONGO_URL) available.push("mongodb");
const drivers = (process.env.DRIVERS?.split(",") ?? available).filter((d) => available.includes(d));

let failures = 0;
for (const name of drivers) {
  const r = await runConformance({
    name,
    driverModule: `${import.meta.dir}/drivers/${name}.ts`,
    kills: Number(process.env.KILLS ?? 8),
    checks: process.env.CHECKS?.split(",") as Check[] | undefined,
    // The first-party drivers that implement PERSIST-01 C7 (single writer); the others follow.
    requireLease: ["memory", "sqlite", "postgres", "mysql", "mongodb"].includes(name),
    // ... and PERSIST-01 C10 (layout version, read-only flag).
    requireLayout: ["memory", "sqlite", "postgres", "mysql", "mongodb"].includes(name),
    // The remote stores bound every call on the client side (STUDY-25 L3): K20 must run.
    requireTimeouts: ["postgres", "mysql", "mongodb"].includes(name),
    // PERSIST-01 C11 (the log by timestamp): every first-party driver has readLog.
    requireReadLog: true,
    // PERSIST-01 C12–C14 (retention: the document log, pruning, globals): every first-party driver.
    requireRetention: true,
    // PERSIST-01 C16 (document versions): every first-party driver.
    requireVersions: true,
  });
  failures += r.failures;
}
console.log(failures ? `${failures} FAILURE(S)` : "all conformance checks passed");
process.exit(failures ? 1 : 0);
