// Bundling an app's functions directory for a push (STUDY-35), as Convex's CLI does
// (npm-packages/convex/src/bundler/index.ts) with Bun.build in place of esbuild:
//
// - every `.js .mjs .cjs .ts .tsx .mts .cts .jsx` file is a module, except `_generated/`, dotfiles, `#…`
//   editor files, `schema.ts`, names with more than one dot (`*.test.ts`, `auth.config.ts`), paths with a
//   space, and TypeScript files that neither import nor export; a `_deps/` directory is an error;
// - `"use node"` files are bundled apart (their own chunks under `_deps/node/`) and may import Node builtins;
//   the others keep any builtin import too, and the server refuses it ("only available in \"use node\"
//   files"), as Convex's browser-platform bundle would fail;
// - `bunvex`, `bunvex/*` and `@bunvex/*` stay external: the server links them to its own modules;
// - ESM, code splitting into `_deps/[hash].js` chunks, source maps, `process.env.NODE_ENV` "production";
// - `schema.ts` and `auth.config.ts` are bundled on their own (`schema.js`, `auth.config.js`).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** A pushed module, as Convex's `ModuleConfig`. */
export type ModuleConfig = { path: string; source: string; sourceMap?: string; environment: "isolate" | "node" };

const EXTENSIONS = [".js", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".jsx"];
const EXTERNAL = ["bunvex", "bunvex/*", "@bunvex/*"];

export class BundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BundleError";
  }
}

const posix = (p: string) => p.split(sep).join("/");

/** Convex's `entryPoints`: the files of `dir` that are modules, sorted. */
export function entryPoints(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name);
      const rel = posix(relative(dir, full));
      if (statSync(full).isDirectory()) {
        if (rel === "_generated" || name.startsWith(".")) continue;
        if (rel === "_deps")
          throw new BundleError(`The functions directory may not contain a "_deps" directory (${full}).`);
        walk(full);
        continue;
      }
      if (!EXTENSIONS.some((e) => name.endsWith(e))) continue;
      if (name.startsWith(".") || name.startsWith("#")) continue;
      if (name === "schema.ts" || name === "schema.js") continue;
      if ((name.match(/\./g) ?? []).length > 1) continue;
      if (rel.includes(" ")) continue;
      if (
        (name.endsWith(".ts") || name.endsWith(".tsx")) &&
        !/^\s{0,100}(import|export)/m.test(readFileSync(full, "utf8"))
      )
        continue;
      out.push(full);
    }
  };
  walk(dir);
  return out;
}

/** Convex's `"use node"` check: the directive among the file's leading statements. */
export function usesNode(source: string): boolean {
  const body = source.replace(/^#!.*\n/, "");
  const directives = /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*((?:(['"])[^'"\n]*\2\s*;?\s*)+)/.exec(body);
  return !!directives && /(['"])use node\1/.test(directives[1]!);
}

async function build(dir: string, entries: string[], node: boolean): Promise<ModuleConfig[]> {
  if (!entries.length) return [];
  const result = await Bun.build({
    entrypoints: entries,
    root: dir,
    splitting: true,
    format: "esm",
    // Bun's browser target replaces Node builtins with empty objects even when they are external; the bun
    // target keeps them as imports, and the server refuses them outside "use node" files (Convex's rule).
    target: "bun",
    sourcemap: "external",
    minify: { syntax: true },
    external: EXTERNAL,
    define: { "process.env.NODE_ENV": '"production"' },
    naming: { entry: "[dir]/[name].js", chunk: node ? "_deps/node/[hash].js" : "_deps/[hash].js" },
    throw: false,
  });
  if (!result.success) {
    const messages = result.logs.map((l) => String(l)).join("\n");
    throw new BundleError(
      /Could not resolve|No matching export/.test(messages) &&
        !node &&
        /node:|"(fs|path|crypto|os|child_process)"/.test(messages)
        ? `${messages}\nIt looks like you are using Node APIs from a file without the "use node" directive.`
        : messages,
    );
  }
  const maps = new Map<string, string>();
  for (const o of result.outputs) if (o.kind === "sourcemap") maps.set(o.path.replace(/\.map$/, ""), await o.text());
  const out: ModuleConfig[] = [];
  for (const o of result.outputs) {
    if (o.kind === "sourcemap") continue;
    const path = posix(o.path.replace(/^\.\//, ""));
    let map = maps.get(o.path);
    // Bun marks its output pre-transpiled (`// @bun`): meaningless to the server's loader, so dropped, and its
    // line with it from the source map, which must match the source (the server reads positions from it).
    const text = await o.text();
    const source = text.replace(/^\/\/ @bun[^\n]*\n/, "");
    if (map && source !== text) map = withoutFirstLine(map);
    out.push({ path, source, ...(map ? { sourceMap: map } : {}), environment: node ? "node" : "isolate" });
  }
  return out;
}

/** A source map with its first generated line dropped (that line's mappings, up to the first `;`). */
export function withoutFirstLine(map: string): string {
  try {
    const m = JSON.parse(map) as { mappings?: unknown };
    if (typeof m.mappings !== "string") return map;
    const i = m.mappings.indexOf(";");
    m.mappings = i === -1 ? "" : m.mappings.slice(i + 1);
    return JSON.stringify(m);
  } catch {
    return map;
  }
}

export type Bundled = { modules: ModuleConfig[]; schema: ModuleConfig | null };

/** The functions directory as a push sends it: its modules (auth.config.js among them) and the schema. */
export async function bundleFunctions(dir: string): Promise<Bundled> {
  if (!existsSync(dir)) throw new BundleError(`No functions directory at ${dir}.`);
  const entries = entryPoints(dir);
  const node: string[] = [];
  const isolate: string[] = [];
  for (const e of entries) (usesNode(readFileSync(e, "utf8")) ? node : isolate).push(e);
  for (const e of node) {
    const rel = posix(relative(dir, e)).replace(/\.[^.]+$/, "");
    if (rel === "http" || rel === "crons")
      throw new BundleError(`${posix(relative(dir, e))} may not use the "use node" directive.`);
  }
  const modules = [...(await build(dir, isolate, false)), ...(await build(dir, node, true))];
  const single = async (names: string[], as: string) => {
    const found = names.map((n) => join(dir, n)).filter(existsSync);
    if (found.length > 1) throw new BundleError(`Found both ${found.join(" and ")}: keep one.`);
    if (!found.length) return null;
    if (usesNode(readFileSync(found[0]!, "utf8")))
      throw new BundleError(`${as.replace(/\.js$/, "")} may not use the "use node" directive.`);
    const r = await Bun.build({
      entrypoints: [found[0]!],
      format: "esm",
      target: "browser",
      external: EXTERNAL,
      throw: false,
    });
    if (!r.success) throw new BundleError(r.logs.map(String).join("\n"));
    const source = (await r.outputs[0]!.text()).replace(/^\/\/ @bun[^\n]*\n/, "");
    return { path: as, source, environment: "isolate" as const };
  };
  const schema = await single(["schema.ts", "schema.js"], "schema.js");
  const auth = await single(["auth.config.ts", "auth.config.js"], "auth.config.js");
  if (auth) modules.push(auth);
  return { modules, schema };
}
