// Publish the @bunvex/* packages to npm (STUDY-40 L7): every package at the same version (a changesets
// "fixed" group), in dependency order, each packed with `bun pm pack` (workspace:* becomes that version) and
// published with npm, which asks for the account's two-factor confirmation.
//
//   bun scripts/publish-npm.ts --dry-run     pack and check, publish nothing
//   bun scripts/publish-npm.ts               publish (run it in a terminal: npm asks to confirm each one)
//   bun scripts/publish-npm.ts --tag alpha   under another dist-tag (default latest: npm wants one named for a
//                                            prerelease, and while there is no stable version the alpha is it)
//
// `bunvex` (the umbrella) is kept back while npm blocks the name (STUDY-40).
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
/** Dependency order: each after the packages it depends on. */
export const PACKAGES = [
  "values",
  "protocol",
  "core",
  "auth",
  "file-storage",
  "persistence",
  "server",
  "client",
  "react",
  "nextjs",
  "cli",
];

const dryRun = process.argv.includes("--dry-run");
const tagAt = process.argv.indexOf("--tag");
const tag = tagAt === -1 ? "latest" : process.argv[tagAt + 1];
if (!tag) throw new Error("--tag needs a value");
const out = join(ROOT, "dist", "npm");

const manifest = (dir: string) =>
  JSON.parse(readFileSync(join(ROOT, "packages", dir, "package.json"), "utf8")) as {
    name: string;
    version: string;
    private?: boolean;
    description?: string;
    dependencies?: Record<string, string>;
  };

async function run(cmd: string[], cwd: string, quiet = false): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(cmd, {
    cwd,
    stdout: quiet ? "pipe" : "inherit",
    stderr: quiet ? "pipe" : "inherit",
    stdin: "inherit",
  });
  const text = quiet ? await new Response(p.stdout).text() : "";
  return { code: await p.exited, out: text };
}

const manifests = PACKAGES.map(manifest);
const versions = new Set(manifests.map((m) => m.version));
if (versions.size !== 1) throw new Error(`the packages must share one version, found ${[...versions].join(", ")}`);
const version = [...versions][0]!;
for (const m of manifests) if (m.private) throw new Error(`${m.name} is private`);

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
console.log(
  `${dryRun ? "Packing" : "Publishing"} ${PACKAGES.length} packages at ${version}${dryRun ? " (dry run)" : ""}`,
);

for (const dir of PACKAGES) {
  const m = manifest(dir);
  const pkgDir = join(ROOT, "packages", dir);
  // npm shows the README and LICENSE of each package: the repository's, when the package has none.
  const added: string[] = [];
  if (!existsSync(join(pkgDir, "LICENSE"))) {
    copyFileSync(join(ROOT, "LICENSE"), join(pkgDir, "LICENSE"));
    added.push("LICENSE");
  }
  if (!existsSync(join(pkgDir, "README.md"))) {
    writeFileSync(
      join(pkgDir, "README.md"),
      `# ${m.name}\n\n${m.description ?? ""}\n\nPart of [bunvex](https://github.com/bunvex/bunvex), a reactive backend for Bun.\n`,
    );
    added.push("README.md");
  }
  try {
    const packed = await run([process.execPath, "pm", "pack", "--destination", out, "--quiet"], pkgDir, true);
    if (packed.code !== 0) throw new Error(`bun pm pack failed in ${dir}`);
    const tgz = packed.out.trim().split("\n").at(-1)!;
    // Every internal dependency must point at this exact version.
    const check = await run(["tar", "-xzOf", tgz, "package/package.json"], ROOT, true);
    const deps = (JSON.parse(check.out) as { dependencies?: Record<string, string> }).dependencies ?? {};
    for (const [name, range] of Object.entries(deps))
      if (name.startsWith("@bunvex/") && range !== version)
        throw new Error(`${m.name} depends on ${name}@${range}, not ${version}: run bun install first`);
    const already = await run(["npm", "view", `${m.name}@${version}`, "version"], ROOT, true);
    if (already.code === 0 && already.out.trim() === version) {
      console.log(`  ${m.name}@${version} is already published`);
      continue;
    }
    if (dryRun) {
      console.log(`  packed ${tgz}`);
      continue;
    }
    console.log(`  publishing ${m.name}@${version} (${tag})`);
    const published = await run(["npm", "publish", tgz, "--access", "public", "--tag", tag], ROOT);
    if (published.code !== 0) throw new Error(`npm publish failed for ${m.name}`);
  } finally {
    for (const f of added) rmSync(join(pkgDir, f), { force: true });
  }
}
console.log(dryRun ? "Dry run: nothing was published." : "Done.");
