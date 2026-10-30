// Publish the @bunvex/* packages to npm (STUDY-40 L7): the fixed group at one version (changesets' "fixed"), then
// helpers and the components at their own versions (STUDY-183 §3.1), in dependency order, each staged as npm gets it (scripts/npm-packages.ts: the sources and
// the compiled JavaScript, STUDY-160; workspace:* becomes that version), packed with `bun pm pack` and
// published with npm, which asks for the account's two-factor confirmation.
//
//   bun scripts/publish-npm.ts --dry-run     pack and check, publish nothing
//   bun scripts/publish-npm.ts               publish (run it in a terminal: npm asks to confirm each one)
//   bun scripts/publish-npm.ts --tag alpha   under another dist-tag (default latest: npm wants one named for a
//                                            prerelease, and while there is no stable version the alpha is it)
//
// npm refuses the unscoped name `bunvex` (STUDY-40 L7): apps install these scoped packages.
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { FIXED, manifest, PACKAGES, stage, versions } from "./npm-packages.ts";

const ROOT = resolve(import.meta.dir, "..");

const dryRun = process.argv.includes("--dry-run");
const tagAt = process.argv.indexOf("--tag");
const tag = tagAt === -1 ? "latest" : process.argv[tagAt + 1];
if (!tag) throw new Error("--tag needs a value");
const out = join(ROOT, "dist", "npm");

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

const fixed = new Set(FIXED.map((d) => manifest(d).version));
if (fixed.size !== 1) throw new Error(`the fixed group must share one version, found ${[...fixed].join(", ")}`);
const version = [...fixed][0]!;
for (const m of PACKAGES.map(manifest)) if (m.private) throw new Error(`${m.name} is private`);
const releaseVersions = versions();

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
console.log(
  `${dryRun ? "Packing" : "Publishing"} ${PACKAGES.length} packages (the fixed group at ${version})${dryRun ? " (dry run)" : ""}`,
);

const staged = stage(join(out, "stage"));
for (const dir of PACKAGES) {
  const m = manifest(dir);
  const packed = await run([process.execPath, "pm", "pack", "--destination", out, "--quiet"], staged.get(dir)!, true);
  if (packed.code !== 0) throw new Error(`bun pm pack failed in ${dir}`);
  const tgz = packed.out.trim().split("\n").at(-1)!;
  // Every internal dependency must point at the version its package is published at (`^` it, for a peer range).
  const check = await run(["tar", "-xzOf", tgz, "package/package.json"], ROOT, true);
  const shipped = JSON.parse(check.out) as Record<string, Record<string, string> | undefined>;
  for (const [name, range] of Object.entries({ ...shipped.dependencies, ...shipped.peerDependencies }))
    if (name.startsWith("@bunvex/") && range.replace(/^\^/, "") !== releaseVersions.get(name))
      throw new Error(`${m.name} depends on ${name}@${range}, not ${releaseVersions.get(name)}`);
  const already = await run(["npm", "view", `${m.name}@${m.version}`, "version"], ROOT, true);
  if (already.code === 0 && already.out.trim() === m.version) {
    console.log(`  ${m.name}@${m.version} is already published`);
    continue;
  }
  if (dryRun) {
    console.log(`  packed ${tgz}`);
    continue;
  }
  console.log(`  publishing ${m.name}@${m.version} (${tag})`);
  const published = await run(["npm", "publish", tgz, "--access", "public", "--tag", tag], ROOT);
  if (published.code !== 0) throw new Error(`npm publish failed for ${m.name}`);
}
console.log(dryRun ? "Dry run: nothing was published." : "Done.");
