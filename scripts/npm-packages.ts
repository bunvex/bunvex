// The @bunvex/* packages as npm gets them (STUDY-160): each package's TypeScript sources, and beside them the
// compiled JavaScript, ES modules and CommonJS each with its `.d.ts` — as Convex's `convex` package ships
// `dist/esm` and `dist/cjs` (npm-packages/convex/scripts/build.py). Bun keeps running the sources (the `bun`
// condition comes first); Node, the bundlers (Next.js, Vite, webpack) and TypeScript get `dist/`.
//
// The repository's own package.json files keep exporting the sources, so the workspace never needs a build:
// only the staged copy written here carries the built `exports`, and that copy is what gets packed.
//
//   bun scripts/npm-packages.ts <dir>     stage every package in <dir>/<package name> (e.g. a node_modules)
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";

const ROOT = resolve(import.meta.dir, "..");

/** Dependency order: each after the packages it depends on. */
export const PACKAGES = [
  "values",
  "search",
  "protocol",
  "core",
  "auth",
  "file-storage",
  "persistence",
  "server",
  "client",
  "react",
  "react-clerk",
  "react-auth0",
  "react-query",
  "nextjs",
  "cli",
];

/** Shipped as sources only: the CLI is a Bun program (`bunx bunvex`, STUDY-40 L7) that no app imports. */
const SOURCES_ONLY = new Set(["cli"]);

export type Manifest = {
  name: string;
  version: string;
  private?: boolean;
  description?: string;
  exports?: Record<string, string | Record<string, string>>;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  files?: string[];
  [key: string]: unknown;
};

export const manifest = (dir: string): Manifest =>
  JSON.parse(readFileSync(join(ROOT, "packages", dir, "package.json"), "utf8")) as Manifest;

/** `./src/a/b.ts` → `./dist/<format>/a/b.<ext>`. */
function built(source: string, format: "esm" | "cjs", ext: "js" | "d.ts"): string {
  const m = /^\.\/src\/(.+)\.tsx?$/.exec(source);
  if (!m) throw new Error(`an export outside src/: ${source}`);
  return `./dist/${format}/${m[1]}.${ext}`;
}

/**
 * The published `exports`: Bun the sources, `import` the ES modules, `require` CommonJS, each with its types.
 * A subpath that already has conditions (`@bunvex/server`: `types`, `bun`, `default`) keeps them: its types
 * from `types`, Bun's from `bun`, everyone else's from `default`.
 */
export function publishedExports(exports: NonNullable<Manifest["exports"]>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [subpath, target] of Object.entries(exports)) {
    const t = typeof target === "string" ? { types: target, bun: target, default: target } : target;
    const types = t.types ?? t.default!;
    const code = t.default!;
    out[subpath] = {
      bun: t.bun ?? code,
      import: { types: built(types, "esm", "d.ts"), default: built(code, "esm", "js") },
      require: { types: built(types, "cjs", "d.ts"), default: built(code, "cjs", "js") },
    };
  }
  out["./package.json"] = "./package.json";
  return out;
}

/** The internal ranges become the release's version: every package is released at once (a fixed group). */
function pinWorkspace(deps: Record<string, string> | undefined, version: string) {
  if (!deps) return undefined;
  return Object.fromEntries(
    Object.entries(deps).map(([name, range]) => [
      name,
      range === "workspace:*" ? version : range.startsWith("workspace:") ? `${range.slice(10)}${version}` : range,
    ]),
  );
}

export function publishedManifest(m: Manifest, build: boolean): Manifest {
  const { devDependencies: _dev, scripts: _scripts, ...rest } = m;
  const out: Manifest = {
    ...rest,
    dependencies: pinWorkspace(m.dependencies, m.version),
    peerDependencies: pinWorkspace(m.peerDependencies, m.version),
    files: build ? ["dist", "src", "README.md", "LICENSE"] : m.files,
  };
  if (!out.dependencies) delete out.dependencies;
  if (!out.peerDependencies) delete out.peerDependencies;
  if (build && m.exports) {
    const exports = publishedExports(m.exports);
    out.exports = exports as Manifest["exports"];
    // For the resolvers that predate `exports` (TypeScript's `node10`, old bundlers), as Convex's.
    const dot = exports["."] as
      | { import: { default: string }; require: { types: string; default: string } }
      | undefined;
    if (dot) {
      out.main = dot.require.default;
      out.module = dot.import.default;
      out.types = dot.require.types;
    }
  }
  return out;
}

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

const SPECIFIER = /(\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)(["'])(\.{1,2}\/[^"']+)\2/gm;

/** Relative specifiers that leave src/ (`../package.json`, for the version) point at the same file from dist/. */
function relocate(code: string, file: string, pkgDir: string, outFile: string, outPkg: string) {
  const src = join(pkgDir, "src");
  return code.replace(SPECIFIER, (all, lead: string, q: string, spec: string) => {
    const target = resolve(dirname(file), spec);
    if (target.startsWith(`${src}/`)) return all;
    let to = relative(dirname(outFile), join(outPkg, relative(pkgDir, target)));
    if (!to.startsWith(".")) to = `./${to}`;
    return `${lead}${q}${to}${q}`;
  });
}

const TRANSPILE: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  jsx: ts.JsxEmit.ReactJSX,
  rewriteRelativeImportExtensions: true,
  isolatedModules: true,
  // CommonJS: a default import of a CommonJS module or of JSON (`../package.json`) is the whole module.
  esModuleInterop: true,
};

/** dist/esm and dist/cjs: each source file compiled on its own (the repository's sources are isolated modules). */
function transpile(dir: string, outPkg: string) {
  const pkgDir = join(ROOT, "packages", dir);
  for (const file of sources(join(pkgDir, "src"))) {
    const rel = relative(join(pkgDir, "src"), file).replace(/\.tsx?$/, ".js");
    const text = readFileSync(file, "utf8");
    for (const [format, module] of [
      ["esm", ts.ModuleKind.ESNext],
      ["cjs", ts.ModuleKind.CommonJS],
    ] as const) {
      const outFile = join(outPkg, "dist", format, rel);
      const { outputText } = ts.transpileModule(text, {
        fileName: file,
        compilerOptions: { ...TRANSPILE, module, verbatimModuleSyntax: format === "esm" },
      });
      mkdirSync(dirname(outFile), { recursive: true });
      writeFileSync(outFile, relocate(outputText, file, pkgDir, outFile, outPkg));
    }
  }
  writeFileSync(join(outPkg, "dist", "cjs", "package.json"), `${JSON.stringify({ type: "commonjs" })}\n`);
}

/**
 * The `.d.ts` of every built package, from one TypeScript program over all their sources (each package's
 * imports of the others resolve to their sources, so nothing is compiled twice).
 */
function declarations(dirs: string[], outDir: string) {
  const config = ts.parseJsonConfigFileContent(
    {
      extends: join(ROOT, "tsconfig.base.json"),
      compilerOptions: {
        noEmit: false,
        declaration: true,
        emitDeclarationOnly: true,
        declarationDir: outDir,
        rootDir: join(ROOT, "packages"),
        lib: ["ESNext", "DOM", "DOM.Iterable"],
        jsx: "react-jsx",
        rewriteRelativeImportExtensions: true,
      },
      include: dirs.map((d) => join(ROOT, "packages", d, "src")),
      exclude: ["**/*.test.ts", "**/*.test.tsx"],
    },
    ts.sys,
    ROOT,
  );
  const program = ts.createProgram(config.fileNames, config.options);
  const result = program.emit(undefined, undefined, undefined, true);
  const errors = result.diagnostics.filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (errors.length > 0)
    throw new Error(
      ts.formatDiagnostics(errors, {
        getCanonicalFileName: (f) => f,
        getCurrentDirectory: () => ROOT,
        getNewLine: () => "\n",
      }),
    );
}

function copyDeclarations(base: string, from: string, outPkg: string, pkgDir: string) {
  for (const name of readdirSync(from)) {
    const p = join(from, name);
    if (statSync(p).isDirectory()) {
      copyDeclarations(base, p, outPkg, pkgDir);
      continue;
    }
    const rel = relative(base, p);
    const text = readFileSync(p, "utf8");
    for (const format of ["esm", "cjs"]) {
      const outFile = join(outPkg, "dist", format, rel);
      mkdirSync(dirname(outFile), { recursive: true });
      // The declaration emit keeps a specifier that leaves src/ (`../package.json`) as written.
      writeFileSync(outFile, relocate(text, join(pkgDir, "src", rel), pkgDir, outFile, outPkg));
    }
  }
}

/**
 * Write every package, as it is packed, into `<out>/<package name>`: package.json with the published
 * `exports` and pinned internal versions, README.md and LICENSE (the repository's when the package has none),
 * src/ without its tests, and dist/.
 */
export function stage(out: string): Map<string, string> {
  const staged = new Map<string, string>();
  const build = PACKAGES.filter((d) => !SOURCES_ONLY.has(d));
  const dts = join(ROOT, "node_modules", ".cache", "bunvex-npm-dts");
  rmSync(dts, { recursive: true, force: true });
  declarations(build, dts);
  for (const dir of PACKAGES) {
    const pkgDir = join(ROOT, "packages", dir);
    const m = manifest(dir);
    if (m.private) throw new Error(`${m.name} is private`);
    const outPkg = join(out, m.name);
    rmSync(outPkg, { recursive: true, force: true });
    mkdirSync(outPkg, { recursive: true });
    const isBuilt = !SOURCES_ONLY.has(dir);
    writeFileSync(join(outPkg, "package.json"), `${JSON.stringify(publishedManifest(m, isBuilt), null, 2)}\n`);
    cpSync(join(pkgDir, "src"), join(outPkg, "src"), {
      recursive: true,
      filter: (p) => !/\.test\.tsx?$/.test(p),
    });
    if (existsSync(join(pkgDir, "bin"))) cpSync(join(pkgDir, "bin"), join(outPkg, "bin"), { recursive: true });
    cpSync(
      existsSync(join(pkgDir, "LICENSE")) ? join(pkgDir, "LICENSE") : join(ROOT, "LICENSE"),
      join(outPkg, "LICENSE"),
    );
    if (existsSync(join(pkgDir, "README.md"))) cpSync(join(pkgDir, "README.md"), join(outPkg, "README.md"));
    else
      writeFileSync(
        join(outPkg, "README.md"),
        `# ${m.name}\n\n${m.description ?? ""}\n\nPart of [bunvex](https://github.com/bunvex/bunvex), a reactive backend for Bun.\n`,
      );
    if (isBuilt) {
      transpile(dir, outPkg);
      copyDeclarations(join(dts, dir, "src"), join(dts, dir, "src"), outPkg, pkgDir);
    }
    staged.set(dir, outPkg);
  }
  return staged;
}

if (import.meta.main) {
  const out = process.argv[2];
  if (!out) throw new Error("usage: bun scripts/npm-packages.ts <dir>");
  const started = performance.now();
  stage(resolve(out));
  console.log(`staged ${PACKAGES.length} packages in ${out} (${Math.round(performance.now() - started)} ms)`);
}
