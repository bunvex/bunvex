// The dependency rules of ARCHITECTURE.md / ARCH-01 D6, enforced. Run: `bun run check:deps` (CI runs it).
//
//   1. a package imports only the @bunvex/* packages its rule allows, and declares every one it imports;
//   2. core imports no external database driver and no HTTP / WebSocket code;
//   3. no relative import leaves its package;
//   4. no source file starts with `// @bun` — Bun reads that as its "already transpiled" pragma and
//      would load the TypeScript as plain JavaScript (found the hard way during the ARCH-01 migration).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const PKGS = join(ROOT, "packages");

/** Which @bunvex packages each package may import (by directory name). */
const ALLOWED: Record<string, string[]> = {
  values: [],
  core: ["values"],
  persistence: ["core"],
  "persistence-conformance": ["core"],
  protocol: [],
  server: ["core", "protocol", "values", "auth", "file-storage", "persistence"],
  client: ["protocol", "values"],
  react: ["client", "values"],
  nextjs: ["react", "client", "values"],
  auth: ["values"],
  "file-storage": [],
  cli: ["server", "core", "values"],
  testing: ["server", "core", "values"],
  bunvex: ["server", "values", "client", "react", "nextjs", "cli"],
};
/** Imports core must never contain (rule 2). */
const CORE_FORBIDDEN = [/^postgres$/, /^mysql2(\/|$)/, /^mongodb$/, /^@bunvex\/persistence(\/|$)/, /^@bunvex\/server/];
const CORE_FORBIDDEN_TEXT = [/\bBun\.serve\b/, /\bnew WebSocket\b/];

const nameOfDir = (dir: string): string => JSON.parse(readFileSync(join(PKGS, dir, "package.json"), "utf8")).name;
const dirOfName = new Map<string, string>();
for (const d of readdirSync(PKGS)) if (statSync(join(PKGS, d)).isDirectory()) dirOfName.set(nameOfDir(d), d);

function* tsFiles(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* tsFiles(p);
    else if (/\.(ts|tsx)$/.test(e.name)) yield p;
  }
}

const importRe = /(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s+["']([^"']+)["']|import\(\s*[`"']([^`"'$]+)/g;
const errors: string[] = [];

for (const [name, dir] of dirOfName) {
  const allowed = ALLOWED[dir];
  if (!allowed) {
    errors.push(
      `${name}: no dependency rule for packages/${dir} — add it to scripts/check-deps.ts and ARCHITECTURE.md`,
    );
    continue;
  }
  const pj = JSON.parse(readFileSync(join(PKGS, dir, "package.json"), "utf8"));
  const declared = new Set([
    ...Object.keys(pj.dependencies ?? {}),
    ...Object.keys(pj.peerDependencies ?? {}),
    ...Object.keys(pj.devDependencies ?? {}),
  ]);
  for (const file of tsFiles(join(PKGS, dir))) {
    const rel = relative(ROOT, file);
    const text = readFileSync(file, "utf8");
    if (text.startsWith("// @bun"))
      errors.push(`${rel}: starts with "// @bun" (Bun's pre-transpiled pragma) — reword the first line`);
    for (const m of text.matchAll(importRe)) {
      const spec = m[1] ?? m[2];
      if (spec.startsWith(".")) {
        const target = resolve(dirname(file), spec);
        if (!target.startsWith(join(PKGS, dir) + "/"))
          errors.push(`${rel}: relative import "${spec}" leaves packages/${dir}`);
        continue;
      }
      const pkg = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
      const targetDir = dirOfName.get(pkg);
      if (targetDir !== undefined) {
        if (targetDir !== dir && !allowed.includes(targetDir))
          errors.push(`${rel}: ${name} may not import ${pkg} (allowed: ${allowed.join(", ") || "none"})`);
        if (targetDir !== dir && !declared.has(pkg))
          errors.push(`${rel}: imports ${pkg} but ${name}/package.json does not declare it`);
      } else if (!spec.startsWith("node:") && !spec.startsWith("bun") && !declared.has(pkg)) {
        errors.push(`${rel}: imports "${pkg}" but ${name}/package.json does not declare it`);
      }
      if (dir === "core" && CORE_FORBIDDEN.some((r) => r.test(spec)))
        errors.push(`${rel}: core must not import "${spec}" (ARCH-01 D6)`);
    }
    if (dir === "core")
      for (const r of CORE_FORBIDDEN_TEXT)
        if (r.test(text)) errors.push(`${rel}: core must not use ${r.source} (ARCH-01 D6)`);
  }
}

if (errors.length) {
  for (const e of errors) console.error(`✗ ${e}`);
  console.error(`\n${errors.length} dependency-rule violation(s)`);
  process.exit(1);
}
console.log(`✓ dependency rules hold across ${dirOfName.size} packages`);
