// `bun run example <name> [dev options]`: run an example (examples/<name>) against this repository's backend,
// for developing bunvex. The example's own `bun run dev` downloads the latest released bunvex-local-backend, as a
// user's app does; this runs the same `dev` with BUNVEX_LOCAL_BACKEND_BINARY pointing to a shim that runs
// packages/bunvex/bin/local-backend.ts with Bun, so the example meets the code it is checked out with.
import { chmodSync, existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const EXAMPLES = join(ROOT, "examples");
const [name, ...devArgs] = process.argv.slice(2);
const names = readdirSync(EXAMPLES)
  .filter((d) => !d.startsWith("_") && existsSync(join(EXAMPLES, d, "package.json")))
  .sort();
if (!name || !names.includes(name)) {
  console.error(`Usage: bun run example <name> [dev options]\n\nExamples: ${names.join(", ")}`);
  process.exit(2);
}

// The shim answers `--version` as a released executable does (the CLI records it), then runs the source.
const shim = join(mkdtempSync(join(tmpdir(), "bunvex-repo-backend-")), "bunvex-local-backend");
writeFileSync(
  shim,
  `#!/bin/sh\n[ "$1" = --version ] && echo "bunvex-local-backend repository" && exit 0\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(ROOT, "packages/bunvex/bin/local-backend.ts"))} "$@"\n`,
);
chmodSync(shim, 0o755);

const dev = Bun.spawn([process.execPath, "run", "dev", ...(devArgs.length ? ["--", ...devArgs] : [])], {
  cwd: join(EXAMPLES, name),
  env: { ...process.env, BUNVEX_LOCAL_BACKEND_BINARY: shim },
  stdio: ["inherit", "inherit", "inherit"],
});
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => dev.kill(signal));
process.exit(await dev.exited);
