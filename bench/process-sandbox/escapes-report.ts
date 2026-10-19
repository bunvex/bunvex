// STUDY-168: prints the escape probes' results in each mode (the table in the study), as JSON.
//   SANDBOX_STUDY=1 bun bench/process-sandbox/escapes-report.ts vm bwrap
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { setup } from "./setup.ts";

const SECRET_ENV = "BUNVEX_STUDY_SECRET";
process.env[SECRET_ENV] = "s3cr3t-admin-key";
const dir = `/root/bunvex-study-secret-${process.pid}`;
mkdirSync(dir, { recursive: true });
writeFileSync(`${dir}/admin-key.txt`, "s3cr3t-admin-key");
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("host") });
for (const mode of process.argv.slice(2) as ("vm" | "process" | "bwrap")[]) {
  const s = await setup(mode, { memoryMiB: 128, pidsMax: 64 });
  const r = await s.functions.runAction("sb:escapes", {
    hostPid: process.pid,
    hostPort: server.port,
    secretFile: `${dir}/admin-key.txt`,
    secretEnv: SECRET_ENV,
  });
  console.log(JSON.stringify({ mode, sabotage: process.env.SANDBOX_SABOTAGE ?? "", ...(r as object) }));
  await s.close();
}
server.stop(true);
rmSync(dir, { recursive: true, force: true });
process.exit(0);
