// The dependency rules of ARCHITECTURE.md / ARCH-01 D6, enforced. Run: `bun run check:deps` (CI runs it).
//
//   1. a package (or an app under apps/) imports only the @bunvex/* packages its rule allows, and declares every one it imports;
//   2. core imports no external database driver and no HTTP / WebSocket code;
//   3. no relative import leaves its package;
//   4. no source file starts with `// @bun` — Bun reads that as its "already transpiled" pragma and
//      would load the TypeScript as plain JavaScript (found the hard way during the ARCH-01 migration).
//   5. no "convex" in the packages' and components' shipped code (packages/*/src, components/*/src) outside comments: not in identifiers,
//      strings, error messages or URLs. bunvex studies and cites Convex (comments, docs/study), but its public
//      API and its messages carry its own names (owner's decision, STUDY-18 D1). Apps (apps/*, e.g. the site
//      comparing benchmarks) may name Convex descriptively. No exceptions, wire names included: a `format`
//      value, a metric or an error code is bunvex's (owner, 2026-10-03: DV-307, DV-308, DV-312). A published
//      package's npm metadata (description, keywords, homepage, repository, bugs, author) ships with it, so it
//      is checked too.
//   6. in the backend packages' shipped code (core, server, persistence, file-storage, search), every `setTimeout(` /
//      `setInterval(` delay is known not to pass 2^31-1 ms: a number literal, a module constant of literals,
//      `timerDelay(…)` (capped; the loop looks again when woken), or `Math.min(…)` with such a bound. Past 2^31-1 ms
//      Bun fires a timer after about 1 ms, so a far sleep busy-loops (STUDY-174 F2, F3, I-25) and a long knob's
//      timeout ends at once (S8). Any other delay (a knob's value, an option, a parameter, a difference of clocks)
//      goes through `timerDelay`, or core's `longTimeout` / `longInterval` / `longSleep`, which sleep any length,
//      as Convex's `Duration`s do (owner, 2026-10-21: Q8). The scans are in scripts/rules.ts (tests: rules.test.ts).
//   7. no `declare` class field in the packages' and components' shipped code (packages/*/src, components/*/src):
//      Babel refuses one without `allowDeclareFields`, and an Expo app in this repository (examples/react-native)
//      bundles the workspace's TypeScript sources through Babel. A type-only field is declared by merging an
//      interface with the class (owner, 2026-10-29).
//   8. the JSDoc of what a published package exports (what an editor shows on hover, and the published `.d.ts`
//      keeps) names no Convex and no study: it is the documentation of bunvex's users, in bunvex's words; the parity
//      note goes in a `//` comment above it (owner, 2026-10-29). scripts/public-docs.ts checks it, after this file
//      (`bun run check:deps` runs both), package by package (its `CHECKED` list).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import {
  checkedTimerCall,
  declareFields,
  literalConstants,
  metadataNaming,
  timerDelays,
  unsafeTimerDelay,
  withoutComments,
} from "./rules.ts";

const ROOT = resolve(import.meta.dir, "..");
const PKGS = join(ROOT, "packages");
const APPS = join(ROOT, "apps");
const EXAMPLES = join(ROOT, "examples");
const COMPONENTS = join(ROOT, "components");

/** Which @bunvex packages each package may import (by directory name; apps as "apps/<dir>"). */
/** The packages an app installs (STUDY-40 L7: the scoped `@bunvex/*` names; npm refuses the unscoped one). */
const PUBLIC = [
  "server",
  "values",
  "client",
  "react",
  "nextjs",
  "react-clerk",
  "react-auth0",
  "react-query",
  "testing",
  "cli",
];
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
  // STUDY-159 T-2 (owner, 2026-10-20): a test pushes the app as `bunvex deploy` bundles it, into an engine of its own.
  // `sandbox`: it starts a server, so it provides the function sandbox's executor, as bin/local-backend.ts does
  // (the server cannot import it, STUDY-171 §8.8); the sandbox imports no testing, so no cycle.
  testing: ["server", "core", "values", "cli", "file-storage", "sandbox"],
  // STUDY-181: the port of convex-helpers. `core` and `testing` only in its tests (TEST_ONLY): an Engine in memory, and
  // `bunvexTest` for the functions its server helpers build.
  helpers: ["server", "values", "core", "testing"],
  // STUDY-171 §7 (STUDY-168 PR 2): the function sandbox's child runs the server's own loader (`@bunvex/server/executor`);
  // §8 (PR 3): its wire carries function references (`@bunvex/protocol`'s symbols).
  sandbox: ["server", "core", "values", "protocol"],
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
    // STUDY-149: the dashboard's server source run through the dashboard's contract suite on a live server
    "dashboard-source",
    "dashboard",
  ],
  // Test-only, never published: Jepsen-style consistency runs against a server process (STUDY-57).
  jepsen: ["client", "server", "core", "values"],
  // Test-only, never published: the same app on Convex's backend and on bunvex's, compared (STUDY-122);
  // it uses bunvex as a user would, through the public packages and its CLI.
  differential: ["server", "values", "client", "react", "nextjs", "cli"],
  // apps/local-backend (STUDY-39, STUDY-40): the executable's entry carries the persistence drivers into it, and
  // provides the function sandbox's executor, which the server cannot import (STUDY-171 §8.8).
  "apps/local-backend": ["server", "core", "persistence", "sandbox"],
  // UI-01 §6: the design system depends on no bunvex package; the dashboard sees data only through its
  // injected DashboardDataSource, never the engine or the server.
  ui: [],
  dashboard: ["ui"],
  // STUDY-149 (owner, 2026-10-12, Q7): the dashboard's source for a bunvex deployment, over the sync client and
  // the contract's types; the dashboard package itself stays on `ui` alone, so the screens serve another host too.
  // `values` (PR 2): ids and value encodings, as Convex's dashboard imports `convex/values`.
  "dashboard-source": ["client", "values", "dashboard"],
  "apps/dashboard": ["dashboard", "dashboard-source", "ui"],
  // SITE-01: the website renders content only; it never talks to a deployment.
  "apps/site": ["ui"],
  // STUDY-90: an example is a user's app: the public packages only (and the shared end-to-end helper).
  "examples/_harness": PUBLIC,
};
/** Packages a package may import from its tests only, never from its shipped code (`src/`). */
const TEST_ONLY: Record<string, string[]> = { helpers: ["core", "testing"] };
/** Every component package (components/<dir>, STUDY-183 §3.1): what it imports, and what only its tests do. */
const componentKeys = () => [...workspaces.keys()].filter((k) => k.startsWith("components/"));
/**
 * A component (components/<dir>, STUDY-183 §3.1) is an app's code: it may import the platform's `server` and
 * `values`, `react` for a `./react` entry (STUDY-197 L-2, a peer dependency), `helpers` (STUDY-158 Q-5), and another
 * component (a child, STUDY-158 §3.3); `testing` from its tests only (`bunvexTest`, `registerComponent`), never from
 * `src/` (its `src/test.ts` types the harness structurally).
 */
const COMPONENT_ALLOWED = () => ["server", "values", "react", "helpers", "testing", ...componentKeys()];
const COMPONENT_TEST_ONLY = ["testing"];
/**
 * Every example (examples/<dir>) may import what a user's app may: the public packages, `helpers` and the component
 * packages (an app installs them as any npm package; STUDY-183 S-4).
 */
const EXAMPLE_ALLOWED = () => [...PUBLIC, "examples/_harness", "helpers", ...componentKeys()];
/** Imports core must never contain (rule 2). */
const CORE_FORBIDDEN = [/^postgres$/, /^mysql2(\/|$)/, /^mongodb$/, /^@bunvex\/persistence(\/|$)/, /^@bunvex\/server/];
const CORE_FORBIDDEN_TEXT = [/\bBun\.serve\b/, /\bnew WebSocket\b/];

/** Every workspace to check: rule key → its directory. */
const workspaces = new Map<string, string>();
for (const [base, prefix] of [
  [PKGS, ""],
  [APPS, "apps/"],
  [EXAMPLES, "examples/"],
  [COMPONENTS, "components/"],
] as const) {
  if (!existsSync(base)) continue;
  for (const d of readdirSync(base))
    if (statSync(join(base, d)).isDirectory()) workspaces.set(prefix + d, join(base, d));
}
const readPkg = (dir: string) => JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
const dirOfName = new Map<string, string>();
for (const [key, dir] of workspaces) dirOfName.set(readPkg(dir).name, key);

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
/** Rule 6's packages: the backend's, where delays come from knobs (packages/sandbox has its own owner, STUDY-171). */
const RULE6_PACKAGES = /^packages\/(core|server|persistence|file-storage|search)\/src\/(?!test-runtime\.ts$)/;

for (const [name, dir] of dirOfName) {
  const root = workspaces.get(dir)!;
  const where = relative(ROOT, root);
  const allowed =
    ALLOWED[dir] ??
    (dir.startsWith("examples/") ? EXAMPLE_ALLOWED() : dir.startsWith("components/") ? COMPONENT_ALLOWED() : undefined);
  const testOnly = TEST_ONLY[dir] ?? (dir.startsWith("components/") ? COMPONENT_TEST_ONLY : undefined);
  if (!allowed) {
    errors.push(`${name}: no dependency rule for ${where} — add it to scripts/check-deps.ts and ARCHITECTURE.md`);
    continue;
  }
  const pj = readPkg(root);
  // packages/* (their keys have no prefix) and components/*, which npm publishes: apps may name Convex descriptively.
  if (!dir.includes("/") || dir.startsWith("components/"))
    for (const field of metadataNaming(pj))
      errors.push(
        `${where}/package.json: "convex" in its ${field}, which npm publishes — use bunvex's own words (rule 5)`,
      );
  const declared = new Set([
    ...Object.keys(pj.dependencies ?? {}),
    ...Object.keys(pj.peerDependencies ?? {}),
    ...Object.keys(pj.devDependencies ?? {}),
  ]);
  for (const file of tsFiles(root)) {
    const rel = relative(ROOT, file);
    const text = readFileSync(file, "utf8");
    if (/^(packages|components)\/[^/]+\/src\//.test(rel)) {
      const stripped = withoutComments(text);
      if (RULE6_PACKAGES.test(rel)) {
        const consts = literalConstants(stripped);
        for (const { line, call, receiver, delay } of timerDelays(stripped))
          if (checkedTimerCall(receiver) && unsafeTimerDelay(delay, consts))
            errors.push(
              `${rel}:${line}: ${call}'s delay \`${delay.replace(/\s+/g, " ").slice(0, 60)}\` may pass 2^31-1 ms — use timerDelay, or longTimeout / longInterval / longSleep from @bunvex/core (rule 6)`,
            );
      }
      for (const { line, text } of declareFields(stripped))
        errors.push(
          `${rel}:${line}: a \`declare\` class field (\`${text.slice(0, 60)}\`), which Babel (React Native's Metro) refuses without allowDeclareFields — declare it by merging an interface (rule 7)`,
        );
      const code = stripped.split("\n");
      code.forEach((line, n) => {
        if (/convex/i.test(line))
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
        else if (testOnly?.includes(targetDir) && rel.startsWith(`${where}/src/`))
          errors.push(`${rel}: ${name} may import ${pkg} from its tests only, not from src/`);
        if (targetDir !== dir && !declared.has(pkg))
          errors.push(`${rel}: imports ${pkg} but ${name}/package.json does not declare it`);
      } else if (
        !spec.startsWith("node:") &&
        !spec.startsWith("bun") &&
        // a module a Vite plugin of the package's own makes (apps/dashboard's `virtual:bunvex-query-types`)
        !spec.startsWith("virtual:") &&
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
