// The declarations the runner's custom test query is typed against (STUDY-162), as Convex's dashboard bundles the
// `convex` package's (`dashboard-common/scripts/build-convexServerTypes.py`): `bunvex/server` and `bunvex/values`,
// and the `@bunvex/*` packages they import, emitted by one TypeScript program over their sources (as STUDY-160's
// `scripts/npm-packages.ts` does at release), keyed by the file each would be in an app's `node_modules`.
// Run at build time by the Vite plugin in vite.config.ts; the browser loads the result as a chunk of its own.
import { dirname, join, relative } from "node:path";
import ts from "typescript";

const ROOT = join(import.meta.dirname, "../..");
/** What `bunvex/server` and `bunvex/values` import, through each other. */
const PACKAGES = ["values", "search", "protocol", "core", "auth", "file-storage", "persistence", "server"];
/** Where a file lives in the editor's file system. */
export const MODULES = "file:///node_modules";

/**
 * `file:///node_modules/…` → text: each package's declarations under `@bunvex/<package>/src/`, a stub per export
 * (`@bunvex/core/index.d.ts`, `@bunvex/core/persistence.d.ts`), and `bunvex/server.d.ts`, `bunvex/values.d.ts`
 * re-exporting theirs.
 */
export function editorTypes(): Record<string, string> {
  const out: Record<string, string> = {};
  const config = ts.parseJsonConfigFileContent(
    {
      extends: join(ROOT, "tsconfig.base.json"),
      compilerOptions: {
        noEmit: false,
        declaration: true,
        emitDeclarationOnly: true,
        declarationDir: "/declarations",
        rootDir: join(ROOT, "packages"),
        lib: ["ESNext", "DOM", "DOM.Iterable"],
        rewriteRelativeImportExtensions: true,
        // written to the map, not to disk
        sourceMap: false,
        declarationMap: false,
      },
      include: PACKAGES.map((d) => join(ROOT, "packages", d, "src")),
      exclude: ["**/*.test.ts", "**/*.test.tsx"],
    },
    ts.sys,
    ROOT,
  );
  const program = ts.createProgram(config.fileNames, config.options);
  const result = program.emit(
    undefined,
    (file, text) => {
      // /declarations/<package>/src/<path>.d.ts
      const rel = relative("/declarations", file);
      const [pkg, ...rest] = rel.split("/");
      if (!pkg || !PACKAGES.includes(pkg)) return;
      out[`${MODULES}/@bunvex/${pkg}/${rest.join("/")}`] = text;
    },
    undefined,
    true,
  );
  const errors = result.diagnostics.filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (errors.length > 0)
    throw new Error(
      ts.formatDiagnostics(errors, {
        getCanonicalFileName: (f) => f,
        getCurrentDirectory: () => ROOT,
        getNewLine: () => "\n",
      }),
    );
  for (const pkg of PACKAGES) {
    const manifest = JSON.parse(ts.sys.readFile(join(ROOT, "packages", pkg, "package.json"))!) as {
      exports: Record<string, string | { types: string }>;
    };
    for (const [subpath, target] of Object.entries(manifest.exports)) {
      const source = typeof target === "string" ? target : target.types;
      const dts = source.replace(/^\.\//, "").replace(/\.ts$/, ".d.ts");
      if (!out[`${MODULES}/@bunvex/${pkg}/${dts}`]) continue; // an export with no declarations (a test helper)
      // the package's root (`index.d.ts`) and each subpath (`@bunvex/core/persistence` → `persistence.d.ts`): a
      // file re-exporting its declarations, found by Node's resolution (no package.json: the editor's files are
      // all TypeScript)
      const stub = `${MODULES}/@bunvex/${pkg}/${subpath === "." ? "index" : subpath.slice(2)}.d.ts`;
      const from = relative(dirname(stub.slice(MODULES.length)), `/@bunvex/${pkg}/${dts}`).replace(/\.d\.ts$/, ".js");
      out[stub] = `export * from "${from.startsWith(".") ? from : `./${from}`}";\n`;
    }
  }
  out[`${MODULES}/bunvex/server.d.ts`] = 'export * from "@bunvex/server";\n';
  out[`${MODULES}/bunvex/values.d.ts`] = 'export * from "@bunvex/values";\n';
  return reachable(out, [`${MODULES}/bunvex/server.d.ts`, `${MODULES}/bunvex/values.d.ts`]);
}

/**
 * Only the files `roots` import, through relative and `@bunvex/*` specifiers (an import, an `export … from`, an
 * import type): the program emits every file of the packages, and the editor needs what the API's types use.
 */
function reachable(files: Record<string, string>, roots: string[]): Record<string, string> {
  const kept: Record<string, string> = {};
  const find = (from: string, spec: string): string | undefined => {
    const base = spec.startsWith(".")
      ? join(dirname(from.slice(MODULES.length)), spec)
      : spec.startsWith("@bunvex/")
        ? `/${spec}`
        : null;
    if (base === null) return undefined; // `node:*` and other packages: not in the editor
    const stem = base.replace(/\.(js|ts)$/, "");
    return [`${stem}.d.ts`, `${stem}/index.d.ts`].map((f) => `${MODULES}${f}`).find((f) => f in files);
  };
  const visit = (file: string) => {
    if (file in kept) return;
    const text = files[file]!;
    kept[file] = text;
    for (const m of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)["']([^"']+)["']/gm)) {
      const next = find(file, m[1]!);
      if (next) visit(next);
    }
  };
  for (const r of roots) visit(r);
  return kept;
}
