// An app's components as a push sends them (STUDY-156 §4.1), as Convex's CLI finds and bundles them
// (npm-packages/convex/src/cli/lib/components/definition/bundle.ts, directoryStructure.ts) with Bun.build:
//
// - the app's definition is `bunvex.config.ts` (or `.js`) in the functions directory; without one, a
//   `defineApp()` of its own, as Convex's virtual config, so every push stores the app's definition (DV-429);
// - the graph: one build from the app's definition with a metafile, each import of a `bunvex.config` file a
//   child definition; packages resolve with the conditions `"bunvex"` and `"module"` (DV-533);
// - a definition's path is its directory relative to the functions directory, POSIX, symlinks resolved
//   (`../node_modules/@bunvex/x/dist/component`), the app's `""`;
// - each definition is bundled on its own with its children's imports made external as
//   `./_componentDeps/<base64url(path)>`, the form the server links; `bunvex/*` stays external (DV-495);
// - each component's functions and schema are bundled as the app's, every module sent (no hashes).
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { BunPlugin } from "bun";
import {
  BundleError,
  bundleFunctions,
  EXTERNAL,
  type ModuleConfig,
  PLUGINS,
  posix,
  withoutFirstLine,
  withSourcesFromOut,
} from "./bundle.ts";

/** The module a definition is pushed as (the server stores it under this name, DV-494). */
export const DEFINITION_MODULE = "bunvex.config.js";
const CONFIG_FILES = ["bunvex.config.ts", "bunvex.config.js"];
const CONDITIONS = ["bunvex", "module"];
/** Convex's virtual config for an app without one (`bundle.ts` `virtualConfig`). */
const DEFAULT_APP = 'import { defineApp } from "bunvex/server";\nconst app = defineApp();\nexport default app;\n';

/** A component's definition as `start_push` takes it (Convex's `ComponentDefinitionConfig`). */
export type ComponentDefinitionConfig = {
  definitionPath: string;
  definition: ModuleConfig;
  dependencies: string[];
  schema: ModuleConfig | null;
  functions: ModuleConfig[];
};

export type BundledComponents = {
  /** The app's `appDefinition.definition` and `dependencies`. */
  app: { definition: ModuleConfig; dependencies: string[] };
  components: ComponentDefinitionConfig[];
};

/** The definition file of the component in `dir`, or null. */
export function definitionFile(dir: string): string | null {
  for (const name of CONFIG_FILES) if (existsSync(join(dir, name))) return join(dir, name);
  return null;
}

const real = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

/** A definition file's path as the server keys it: its directory relative to the app's, `""` for the app. */
export const definitionPathOf = (root: string, file: string) => posix(relative(real(root), real(dirname(file))));

type Graph = {
  /** Every definition file, the app's first, each before its children's (breadth first). */
  files: string[];
  /** Each definition's direct children, in import order. */
  children: Map<string, string[]>;
  /** `importer \0 specifier` → the definition file it names. */
  imports: Map<string, string>;
};

/** Convex's `componentGraph`: the definitions reachable from the app's, from Bun's metafile. */
async function componentGraph(appFile: string, conditions: string[]): Promise<Graph> {
  const r = await Bun.build({
    entrypoints: [appFile],
    metafile: true,
    format: "esm",
    target: "browser",
    conditions,
    external: EXTERNAL,
    plugins: PLUGINS,
    throw: false,
  });
  if (!r.success || !r.metafile) throw new BundleError(r.logs.map(String).join("\n"));
  // The metafile names inputs relative to this process's working directory.
  const inputs = new Map(
    Object.entries(r.metafile.inputs).map(([path, input]) => [real(resolve(process.cwd(), path)), input]),
  );
  const graph: Graph = { files: [], children: new Map(), imports: new Map() };
  const queue = [real(appFile)];
  while (queue.length) {
    const file = queue.shift()!;
    if (graph.children.has(file)) continue;
    graph.files.push(file);
    const kids: string[] = [];
    for (const imp of inputs.get(file)?.imports ?? []) {
      if (imp.external || !imp.original || !/bunvex\.config/.test(imp.original)) continue;
      const child = real(resolve(process.cwd(), imp.path));
      if (!CONFIG_FILES.includes(basename(child)))
        throw new BundleError(
          `Invalid component directory (Component definition ${CONFIG_FILES[0]} isn't a file): ${dirname(child)}`,
        );
      graph.imports.set(`${file}\0${imp.original}`, child);
      if (!kids.includes(child)) kids.push(child);
      queue.push(child);
    }
    graph.children.set(file, kids);
  }
  return graph;
}

/** One definition bundled, its children's imports external as `./_componentDeps/<base64url(path)>`. */
async function bundleDefinition(
  root: string,
  file: string,
  graph: Graph,
  conditions: string[],
  project: string,
  includeSourcesContent: boolean,
): Promise<ModuleConfig> {
  const deps: BunPlugin = {
    name: "bunvex-component-deps",
    setup(build) {
      build.onResolve({ filter: /bunvex\.config/ }, (args) => {
        if (args.kind.startsWith("entry-point")) return undefined;
        const child = graph.imports.get(`${real(args.importer)}\0${args.path}`);
        if (child === undefined) return undefined;
        const path = Buffer.from(definitionPathOf(root, child)).toString("base64url");
        return { path: `./_componentDeps/${path}`, external: true };
      });
    },
  };
  const r = await Bun.build({
    entrypoints: [file],
    format: "esm",
    target: "browser",
    conditions,
    sourcemap: "external",
    minify: { syntax: true },
    external: EXTERNAL,
    plugins: [deps, ...PLUGINS],
    throw: false,
  });
  if (!r.success) throw new BundleError(r.logs.map(String).join("\n"));
  const out = r.outputs.find((o) => o.kind !== "sourcemap")!;
  const map = r.outputs.find((o) => o.kind === "sourcemap");
  const text = await out.text();
  const source = text.replace(/^\/\/ @bun[^\n]*\n/, "");
  let sourceMap = map ? await map.text() : undefined;
  if (sourceMap && source !== text) sourceMap = withoutFirstLine(sourceMap);
  const at = definitionPathOf(root, file);
  if (sourceMap)
    sourceMap = withSourcesFromOut(
      sourceMap,
      at ? `${at}/${DEFINITION_MODULE}` : DEFINITION_MODULE,
      project,
      includeSourcesContent,
    );
  return { path: DEFINITION_MODULE, source, ...(sourceMap ? { sourceMap } : {}), environment: "isolate" };
}

/**
 * The app's definition and its components, as `start_push` takes them. `liveComponentSources`: packages resolve
 * to their sources (the `"@bunvex/component-source"` condition, Convex's `--live-component-sources`).
 */
export async function bundleComponents(
  root: string,
  project: string,
  { includeSourcesContent = false, liveComponentSources = false } = {},
): Promise<BundledComponents> {
  const appFile = definitionFile(root);
  if (appFile === null)
    return {
      app: { definition: { path: DEFINITION_MODULE, source: DEFAULT_APP, environment: "isolate" }, dependencies: [] },
      components: [],
    };
  const conditions = liveComponentSources ? ["@bunvex/component-source", ...CONDITIONS] : CONDITIONS;
  const graph = await componentGraph(appFile, conditions);
  const dependencies = (file: string) => graph.children.get(file)!.map((c) => definitionPathOf(root, c));
  const definition = (file: string) => bundleDefinition(root, file, graph, conditions, project, includeSourcesContent);
  const [app, ...children] = graph.files;
  const components: ComponentDefinitionConfig[] = [];
  for (const file of children) {
    const dir = dirname(file);
    const bundled = await bundleFunctions(dir, project, { includeSourcesContent, component: true });
    components.push({
      definitionPath: definitionPathOf(root, file),
      definition: await definition(file),
      dependencies: dependencies(file),
      schema: bundled.schema,
      functions: bundled.modules,
    });
  }
  return { app: { definition: await definition(app!), dependencies: dependencies(app!) }, components };
}
