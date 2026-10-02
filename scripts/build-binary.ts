// The standalone executables (STUDY-39), as Convex's precompiled `convex-local-backend`: `bunvex` compiled
// with `bun build --compile` for each platform Convex ships, zipped as `bunvex-<target>.zip` (Convex's
// `convex-local-backend-<target>.zip`, the same Rust target names).
//
//   bun scripts/build-binary.ts                        every target, into dist/bin
//   bun scripts/build-binary.ts --target x86_64-unknown-linux-gnu --version 2026-10-02-abc1234
//   bun scripts/build-binary.ts --host                 this machine's target only (for a local try)
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const ENTRY = join(ROOT, "packages/bunvex/bin/standalone.ts");

/** Convex's targets, and the Bun target that builds each. */
export const TARGETS: Record<string, string> = {
  "aarch64-apple-darwin": "bun-darwin-arm64",
  "x86_64-apple-darwin": "bun-darwin-x64",
  "aarch64-unknown-linux-gnu": "bun-linux-arm64",
  "x86_64-unknown-linux-gnu": "bun-linux-x64",
  "x86_64-pc-windows-msvc": "bun-windows-x64",
};

export function hostTarget(): string {
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  if (process.platform === "darwin") return `${arch}-apple-darwin`;
  if (process.platform === "win32") return "x86_64-pc-windows-msvc";
  return `${arch}-unknown-linux-gnu`;
}

async function run(cmd: string[], cwd = ROOT) {
  const p = Bun.spawn(cmd, { cwd, stdout: "inherit", stderr: "inherit" });
  if ((await p.exited) !== 0) throw new Error(`failed: ${cmd.join(" ")}`);
}

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const targets = args.includes("--host")
  ? [hostTarget()]
  : args.flatMap((a, i) => (args[i - 1] === "--target" ? [a] : [])).length
    ? args.flatMap((a, i) => (args[i - 1] === "--target" ? [a] : []))
    : Object.keys(TARGETS);
const version = opt("--version") ?? "dev";
const out = resolve(ROOT, opt("--out") ?? "dist/bin");

for (const t of targets) if (!TARGETS[t]) throw new Error(`unknown target ${t} (${Object.keys(TARGETS).join(", ")})`);
mkdirSync(out, { recursive: true });
for (const target of targets) {
  const exe = target.includes("windows") ? "bunvex.exe" : "bunvex";
  const dir = join(out, target);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  await run([
    process.execPath,
    "build",
    "--compile",
    `--target=${TARGETS[target]}`,
    "--minify-syntax",
    `--define=BUNVEX_BUILD_VERSION=${JSON.stringify(version)}`,
    ENTRY,
    "--outfile",
    join(dir, exe),
  ]);
  const zip = join(out, `bunvex-${target}.zip`);
  rmSync(zip, { force: true });
  await run(["zip", "-q", "-j", zip, join(dir, exe)]);
  console.log(`built ${zip}`);
}
