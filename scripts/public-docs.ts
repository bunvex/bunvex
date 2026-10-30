// Rule 8 of scripts/check-deps.ts: the documentation an app's developer reads (owner, 2026-10-29). The JSDoc of
// every symbol a published package exports, and of its members, is what an editor shows on hover and what the
// published `.d.ts` keeps: it says what the symbol does in bunvex's words, with no "Convex" and no study reference
// (`STUDY-NN`). The parity trail (Convex's name, file or behaviour) goes in a `//` comment above it, which neither
// shows. The user docs (published READMEs, the examples' READMEs, the guides) carry no study, divergence or addition
// number either, and the examples' code does not name Convex (`userDocFindings`). Run by `bun run check:deps`; `bun scripts/public-docs.ts --list` prints every finding of every package,
// those not checked yet included.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";

const ROOT = resolve(import.meta.dir, "..");

/** The packages whose public documentation is checked (`--list` prints every finding without failing). */
export const CHECKED = [
  "packages/values",
  "packages/client",
  "packages/react",
  "packages/react-clerk",
  "packages/react-auth0",
  "packages/react-query",
  "packages/nextjs",
  "packages/server",
  "packages/testing",
  "packages/helpers",
  "components/batch-worker",
  "components/rate-limiter",
  "components/resend",
  "components/sharded-counter",
  "components/workpool",
];
/** Every package an app imports from, for `--list`: all of them are checked now. */
const ALL = CHECKED;
/** `--only <path>`: the findings in files under that path only (with `--list`). */
const ONLY = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : undefined;

/** What the documentation of a public symbol may not say: the platform bunvex imitates, or a study's number. */
export const FORBIDDEN = /convex|STUDY-\d+/i;

export type Finding = { pkg: string; name: string; at: string; text: string };

/** Each entry point (`exports` subpath) of `dir`, as its TypeScript source. */
function entries(dir: string): { name: string; file: string }[] {
  const pkg = JSON.parse(readFileSync(join(ROOT, dir, "package.json"), "utf8")) as {
    name: string;
    exports?: Record<string, string | Record<string, string>>;
  };
  const out: { name: string; file: string }[] = [];
  for (const [sub, target] of Object.entries(pkg.exports ?? {})) {
    const file = typeof target === "string" ? target : (target.types ?? target.default ?? target.bunvex);
    if (file?.endsWith(".ts") || file?.endsWith(".tsx"))
      out.push({ name: sub === "." ? pkg.name : `${pkg.name}${sub.slice(1)}`, file: join(ROOT, dir, file) });
  }
  return out;
}

/** The findings of `dirs`: every exported symbol and member whose JSDoc says what FORBIDDEN refuses. */
export function publicDocFindings(dirs: string[]): Finding[] {
  const all = dirs.flatMap((dir) => entries(dir).map((e) => ({ ...e, dir })));
  const program = ts.createProgram(
    all.map((e) => e.file),
    {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      allowImportingTsExtensions: true,
      jsx: ts.JsxEmit.ReactJSX,
      noEmit: true,
      skipLibCheck: true,
    },
  );
  const checker = program.getTypeChecker();
  const findings: Finding[] = [];
  const seen = new Set<ts.Symbol>();
  const visit = (pkg: string, symbol: ts.Symbol, name: string, depth: number) => {
    const s = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
    if (seen.has(s)) return;
    seen.add(s);
    const decl = s.declarations?.[0];
    if (!decl || decl.getSourceFile().fileName.includes("node_modules")) return;
    const text = (s.declarations ?? [])
      .flatMap((d) => ts.getJSDocCommentsAndTags(d).map((j) => j.getText()))
      .join("\n");
    if (FORBIDDEN.test(text)) {
      const sf = decl.getSourceFile();
      const line = sf.getLineAndCharacterOfPosition(decl.getStart()).line + 1;
      findings.push({ pkg, name, at: `${relative(ROOT, sf.fileName)}:${line}`, text: FORBIDDEN.exec(text)![0] });
    }
    if (depth > 1) return;
    for (const m of [...(s.members?.values() ?? []), ...(s.exports?.values() ?? [])])
      if (!String(m.escapedName).startsWith("__")) visit(pkg, m, `${name}.${m.escapedName}`, depth + 1);
  };
  for (const e of all) {
    const sf = program.getSourceFile(e.file);
    const mod = sf && checker.getSymbolAtLocation(sf);
    if (!mod) continue;
    for (const symbol of checker.getExportsOfModule(mod)) visit(e.dir, symbol, `${e.name}:${symbol.escapedName}`, 0);
  }
  return findings;
}

/** The user docs (owner, 2026-10-29): what bunvex's users read besides the JSDoc. */
export function userDocFiles(): string[] {
  const out = ["docs/dashboard.md", "docs/rooms.md", "docs/upgrading.md", "docker/README.md", "examples/README.md"];
  for (const base of ["packages", "components"])
    for (const d of readdirSync(join(ROOT, base))) {
      const pkg = join(ROOT, base, d, "package.json");
      if (!existsSync(pkg) || (JSON.parse(readFileSync(pkg, "utf8")) as { private?: boolean }).private) continue;
      if (existsSync(join(ROOT, base, d, "README.md"))) out.push(`${base}/${d}/README.md`);
    }
  for (const d of readdirSync(join(ROOT, "examples")))
    if (!d.startsWith("_") && existsSync(join(ROOT, "examples", d, "README.md"))) out.push(`examples/${d}/README.md`);
  return out;
}

/** A study, divergence or addition number: the maintainers' references, which a user cannot follow. */
export const INTERNAL_REFERENCE = /\b(STUDY|DV|AD)-\d+\b/;

/**
 * The user docs' internal references (each published package's README, the examples' READMEs, the user guides), and
 * the examples' code comments that name Convex: an example is an app its reader copies. The docs may name Convex
 * where a reader moves from or to it; the examples' index credits Convex's demos once, in its README.
 */
export function userDocFindings(): Finding[] {
  const findings: Finding[] = [];
  for (const file of userDocFiles())
    readFileSync(join(ROOT, file), "utf8")
      .split("\n")
      .forEach((line, n) => {
        const m = INTERNAL_REFERENCE.exec(line);
        if (m) findings.push({ pkg: file, name: file, at: `${file}:${n + 1}`, text: m[0] });
      });
  const code = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = join(dir, e.name);
      if (e.isDirectory()) return ["node_modules", "_generated", "dist", ".expo"].includes(e.name) ? [] : code(p);
      return /\.(ts|tsx)$/.test(e.name) ? [p] : [];
    });
  for (const d of readdirSync(join(ROOT, "examples")))
    if (!d.startsWith("_") && statSync(join(ROOT, "examples", d)).isDirectory())
      for (const file of code(join(ROOT, "examples", d)))
        readFileSync(file, "utf8")
          .split("\n")
          .forEach((line, n) => {
            if (/convex/i.test(line))
              findings.push({
                pkg: "examples",
                name: relative(ROOT, file),
                at: `${relative(ROOT, file)}:${n + 1}`,
                text: "Convex",
              });
          });
  return findings;
}

if (import.meta.main) {
  const list = process.argv.includes("--list");
  const findings = publicDocFindings(list ? ALL : CHECKED).filter((f) => !ONLY || f.at.startsWith(ONLY));
  for (const f of findings) console.log(`${f.at}: ${f.name} — its documentation says "${f.text}"`);
  if (list) {
    const counts = new Map<string, number>();
    for (const f of findings) counts.set(f.pkg, (counts.get(f.pkg) ?? 0) + 1);
    for (const [pkg, n] of counts) console.log(`${pkg}: ${n}`);
  } else if (findings.length > 0) {
    console.error(
      `\n${findings.length} public symbol(s) whose documentation names Convex or a study: say what it does in bunvex's words, and move the parity note to a \`//\` comment above it (rule 8)`,
    );
    process.exit(1);
  } else console.log(`✓ the public documentation of ${CHECKED.length} packages is in bunvex's words`);
  const docs = userDocFindings();
  for (const f of docs) console.log(`${f.at}: says "${f.text}"`);
  if (docs.length > 0 && !list) {
    console.error(
      `\n${docs.length} line(s) of the user docs with a study, divergence or addition number, or an example naming Convex: say it in plain words (rule 8)`,
    );
    process.exit(1);
  } else if (!list)
    console.log(`✓ the user docs (${userDocFiles().length} files) and the examples' code are in bunvex's words`);
}
