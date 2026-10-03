// The dependency rules of ARCHITECTURE.md / ARCH-01 D6, enforced. Run: `bun run check:deps` (CI runs it).
//
//   1. a package (or an app under apps/) imports only the @bunvex/* packages its rule allows, and declares every one it imports;
//   2. core imports no external database driver and no HTTP / WebSocket code;
//   3. no relative import leaves its package;
//   4. no source file starts with `// @bun` — Bun reads that as its "already transpiled" pragma and
//      would load the TypeScript as plain JavaScript (found the hard way during the ARCH-01 migration).
//   5. no "convex" in the packages' shipped code (packages/*/src) outside comments: not in identifiers,
//      strings, error messages or URLs. bunvex studies and cites Convex (comments, docs/study), but its public
//      API and its messages carry its own names (owner's decision, STUDY-18 D1). Apps (apps/*, e.g. the site
//      comparing benchmarks) may name Convex descriptively.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const PKGS = join(ROOT, "packages");
const APPS = join(ROOT, "apps");

/** Which @bunvex packages each package may import (by directory name; apps as "apps/<dir>"). */
const ALLOWED: Record<string, string[]> = {
  values: [],
  // STUDY-45 (owner, 2026-10-02: search in a package of its own): the tokenizer, index and ranking.
  search: ["values"],
  core: ["values", "search"],
  persistence: ["core"],
  "persistence-conformance": ["core", "values"],
  protocol: [],
  server: ["core", "protocol", "values", "auth", "file-storage", "persistence"],
  client: ["protocol", "values"],
  react: ["client", "values"],
  nextjs: ["react", "client", "values"],
  "react-clerk": ["react"],
  "react-auth0": ["react"],
  "react-query": ["react", "client", "values"],
  auth: ["values"],
  "file-storage": [],
  // STUDY-37 E5 (owner, 2026-10-02): the CLI subscribes as Convex's does (`run --watch`).
  cli: ["server", "core", "values", "client", "protocol"],
  testing: ["server", "core", "values"],
  // Test-only, never published: end-to-end sync tests (a server and clients in one process, STUDY-26).
  "sync-e2e": [
    "client",
    "react",
    "nextjs",
    "react-clerk",
    "react-auth0",
    "react-query",
    "server",
    "core",
    "protocol",
    "values",
  ],
  // Test-only, never published: Jepsen-style consistency runs against a server process (STUDY-57).
  jepsen: ["client", "server", "core", "values"],
  // bin/local-backend.ts (STUDY-39, STUDY-40) carries the persistence drivers into the executable.
  bunvex: ["server", "values", "client", "react", "nextjs", "react-clerk", "react-auth0", "cli", "core", "persistence"],
  // UI-01 §6: the design system depends on no bunvex package; the dashboard sees data only through its
  // injected DashboardDataSource, never the engine or the server.
  ui: [],
  dashboard: ["ui"],
  "apps/dashboard": ["dashboard", "ui"],
  // SITE-01: the website renders content only; it never talks to a deployment.
  "apps/site": ["ui"],
};
/** Imports core must never contain (rule 2). */
const CORE_FORBIDDEN = [/^postgres$/, /^mysql2(\/|$)/, /^mongodb$/, /^@bunvex\/persistence(\/|$)/, /^@bunvex\/server/];
const CORE_FORBIDDEN_TEXT = [/\bBun\.serve\b/, /\bnew WebSocket\b/];

/** Every workspace to check: rule key → its directory. */
const workspaces = new Map<string, string>();
for (const [base, prefix] of [
  [PKGS, ""],
  [APPS, "apps/"],
] as const) {
  if (!existsSync(base)) continue;
  for (const d of readdirSync(base))
    if (statSync(join(base, d)).isDirectory()) workspaces.set(prefix + d, join(base, d));
}
const readPkg = (dir: string) => JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
const dirOfName = new Map<string, string>();
for (const [key, dir] of workspaces) dirOfName.set(readPkg(dir).name, key);

/**
 * The code of a TS/TSX source with its comments blanked out (strings, template literals and regex-free code
 * kept), so rule 5 sees identifiers, strings and URLs but not the comments that cite Convex.
 */
function withoutComments(text: string): string {
  let out = "";
  let i = 0;
  let quote: string | null = null;
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (quote) {
      out += c;
      if (c === "\\") {
        out += next ?? "";
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i++;
    } else if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? text.length : end + 2;
      out += text.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
    } else {
      if (c === '"' || c === "'" || c === "`") quote = c;
      out += c;
      i++;
    }
  }
  return out;
}

/**
 * Rule 5's exceptions (owner, 2026-10-03): wire names Convex clients and connectors send or read, matched as
 * exact string literals. Each needs the decision that allows it; messages and API names never qualify.
 */
const WIRE_NAMES: Record<string, string> = {
  convex_encoded_json: "DV-307: streaming export and HTTP function API `format`",
  convex_json: "DV-307: streaming export `format` (legacy alias)",
  convex_clean_json: "DV-307: streaming export `format` (legacy alias)",
  actionComputeConvexGbHours: "DV-308: usage limit metric",
};
const wireNameRe = new RegExp(`(["'\`])(?:${Object.keys(WIRE_NAMES).join("|")})\\1`, "g");

function* tsFiles(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* tsFiles(p);
    else if (/\.(ts|tsx)$/.test(e.name)) yield p;
  }
}

// `import … from "x"` / `export … from "x"`, side-effect `import "x"`, and `import("x")` with a literal.
const importRe =
  /(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s+["']([^"']+)["']|import\(\s*[`"']([^`"'$]+)|(?:^|\n)\s*import\s*["']([^"']+)["']/g;
const errors: string[] = [];

for (const [name, dir] of dirOfName) {
  const root = workspaces.get(dir)!;
  const where = relative(ROOT, root);
  const allowed = ALLOWED[dir];
  if (!allowed) {
    errors.push(`${name}: no dependency rule for ${where} — add it to scripts/check-deps.ts and ARCHITECTURE.md`);
    continue;
  }
  const pj = readPkg(root);
  const declared = new Set([
    ...Object.keys(pj.dependencies ?? {}),
    ...Object.keys(pj.peerDependencies ?? {}),
    ...Object.keys(pj.devDependencies ?? {}),
  ]);
  for (const file of tsFiles(root)) {
    const rel = relative(ROOT, file);
    const text = readFileSync(file, "utf8");
    if (/^packages\/[^/]+\/src\//.test(rel)) {
      const code = withoutComments(text).split("\n");
      code.forEach((line, n) => {
        if (/convex/i.test(line.replace(wireNameRe, "")))
          errors.push(
            `${rel}:${n + 1}: "convex" in shipped code outside a comment — use bunvex's own names and messages (rule 5)`,
          );
      });
    }
    if (text.startsWith("// @bun"))
      errors.push(`${rel}: starts with "// @bun" (Bun's pre-transpiled pragma) — reword the first line`);
    for (const m of text.matchAll(importRe)) {
      const spec = (m[1] ?? m[2] ?? m[3])!;
      if (spec.startsWith(".")) {
        const target = resolve(dirname(file), spec);
        if (!target.startsWith(`${root}/`)) errors.push(`${rel}: relative import "${spec}" leaves ${where}`);
        continue;
      }
      const pkg = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
      const targetDir = dirOfName.get(pkg);
      if (targetDir !== undefined) {
        if (targetDir !== dir && !allowed.includes(targetDir))
          errors.push(`${rel}: ${name} may not import ${pkg} (allowed: ${allowed.join(", ") || "none"})`);
        if (targetDir !== dir && !declared.has(pkg))
          errors.push(`${rel}: imports ${pkg} but ${name}/package.json does not declare it`);
      } else if (
        !spec.startsWith("node:") &&
        !spec.startsWith("bun") &&
        !declared.has(pkg) &&
        // a types-only package (e.g. "geojson") is declared by its @types package
        !declared.has(`@types/${pkg.replace(/^@/, "").replace("/", "__")}`)
      ) {
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
