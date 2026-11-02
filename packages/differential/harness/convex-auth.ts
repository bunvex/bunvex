// `@convex-dev/auth` at the commit bunvex follows (STUDY-201 C-1, `docs/parity/upstream.md`), for the auth differential
// test's Convex side. The pin is unreleased (npm's 2.0.0-beta.0 predates it by 36 commits), so it is built from the
// reference clone, as its own release does (pnpm, then `pnpm pack`), and installed once into `.cache/` with its
// dependencies but not its peers: its `convex` is then this package's, the one the Convex CLI bundles with.
// `package.json` declares npm's latest, 2.0.0-beta.0, for the app's imports; the test's Convex project links the pin instead.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PACKAGE = resolve(import.meta.dir, "..");
const ROOT = resolve(PACKAGE, "../..");
export const CONVEX_AUTH_PIN = "db15c82e";
/** pnpm as the repository's `packageManager` names it. */
const PNPM = "pnpm@10.16.0";
/** The clone: `CONVEX_AUTH_REPO`, or `convex-auth` beside bunvex's repository. */
const REPO = process.env.CONVEX_AUTH_REPO ?? resolve(ROOT, "../convex-auth");
const CACHE = join(PACKAGE, ".cache", `convex-auth-${CONVEX_AUTH_PIN}`);

function run(cmd: string[], cwd: string): void {
  const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed (in ${cwd}):\n${p.stdout}\n${p.stderr}`);
}

/**
 * The `node_modules` holding `@convex-dev/auth` at the pin and its dependencies, built on first use; null (with why)
 * when there is no clone to build it from.
 */
export function convexAuthModules(): { modules: string } | { missing: string } {
  const modules = join(CACHE, "node_modules");
  if (existsSync(join(modules, "@convex-dev/auth/package.json"))) return { modules };
  if (!existsSync(join(REPO, ".git"))) return { missing: `no convex-auth clone at ${REPO} (set CONVEX_AUTH_REPO)` };
  const work = mkdtempSync(join(tmpdir(), "convex-auth-pin-"));
  try {
    run(["git", "-C", REPO, "worktree", "add", "--detach", work, CONVEX_AUTH_PIN], REPO);
    // Its install builds it (`prepare`).
    run(["npx", "-y", PNPM, "install", "--frozen-lockfile", "--filter", "@convex-dev/auth..."], work);
    rmSync(CACHE, { recursive: true, force: true });
    mkdirSync(CACHE, { recursive: true });
    run(["npx", "-y", PNPM, "pack", "--pack-destination", CACHE], join(work, "packages/core"));
    const tarball = readdirSync(CACHE).find((f) => f.endsWith(".tgz"));
    if (!tarball) throw new Error("convex-auth: pnpm pack wrote no tarball");
    writeFileSync(
      join(CACHE, "package.json"),
      JSON.stringify({
        name: "convex-auth-pin",
        private: true,
        dependencies: { "@convex-dev/auth": `file:./${tarball}` },
      }),
    );
    run(
      ["npm", "install", "--legacy-peer-deps", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"],
      CACHE,
    );
    return { modules };
  } finally {
    Bun.spawnSync(["git", "-C", REPO, "worktree", "remove", "--force", work]);
    rmSync(work, { recursive: true, force: true });
  }
}
