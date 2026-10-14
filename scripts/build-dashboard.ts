// `dashboard.zip` (STUDY-149 PR 7, closes DV-194), as Convex attaches its dashboard's static export to every
// release (precompile.yml: `build:export` with NEXT_PUBLIC_USE_CURRENT_DEPLOYMENT_API=true, zipped from `out/`):
// apps/dashboard built with VITE_BUNVEX_USE_CURRENT_DEPLOYMENT=1, so the local dashboard `bunvex dev` serves
// from it signs in from its server's `/api/current_deployment`; the files at the archive's root.
//
//   bun scripts/build-dashboard.ts                 into dist/bin/dashboard.zip
//   bun scripts/build-dashboard.ts --out <dir>
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
const i = args.indexOf("--out");
const out = resolve(ROOT, i === -1 ? "dist/bin" : (args[i + 1] ?? "dist/bin"));
const build = join(ROOT, "dist/dashboard");

async function run(cmd: string[], cwd: string, env: Record<string, string> = {}) {
  const p = Bun.spawn(cmd, { cwd, env: { ...process.env, ...env }, stdout: "inherit", stderr: "inherit" });
  if ((await p.exited) !== 0) throw new Error(`failed: ${cmd.join(" ")}`);
}

rmSync(build, { recursive: true, force: true });
await run(
  [process.execPath, "--bun", "vite", "build", "--outDir", build, "--emptyOutDir"],
  join(ROOT, "apps/dashboard"),
  { NODE_ENV: "production", VITE_BUNVEX_USE_CURRENT_DEPLOYMENT: "1" },
);
if (!existsSync(join(build, "index.html"))) throw new Error("the build has no index.html");
mkdirSync(out, { recursive: true });
const zip = join(out, "dashboard.zip");
rmSync(zip, { force: true });
await run(["zip", "-q", "-r", "-X", zip, "."], build);
console.log(`built ${zip} (${Bun.file(zip).size} bytes)`);
