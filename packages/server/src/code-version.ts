// A code version (STUDY-35, DV-164): a push's modules loaded into a `vm` context of their own, in the server's
// process, and analyzed as Convex's `analyze` reads them (crates/isolate/src/environment/analyze.rs).
//
// - Each module is a `SourceTextModule`. Imports link to the server's own `bunvex/*` modules (so the builders
//   and validators are the server's), to the bundle's own modules and chunks, and — for `"use node"`
//   modules only — to Node and Bun builtins (DV-169). Anything else does not resolve, as on Convex.
// - Two contexts per version, as Convex has two runtimes: the default one with web APIs, and the Node one
//   with Node's globals too. Each gets deterministic `Date` / `Math.random` (installDeterminismIn); fetch,
//   timers, `performance` and `crypto` are the server's, already deterministic in queries and mutations.
// - Modules are evaluated in Convex's import phase: seeded `Math.random`, fixed `Date.now()`, no fetch,
//   timers or randomness, under a time limit (ISOLATE_ANALYZE_USER_TIMEOUT_SECONDS, 4 s).
// - Superseded versions are collected once nothing references them (re-importing ES modules would keep
//   every version alive: ~6 MB per push of a 0.9 MB bundle, measured).
//
// This is not a security boundary: `vm` is not one (DV-164; ARCH-01 decision 3 stays open).
import { createHash } from "node:crypto";
import { builtinModules } from "node:module";
import { posix } from "node:path";
import vm from "node:vm";
import { installDeterminismIn, runImportPhase } from "@bunvex/core";
import { type CronSpec, Crons, cronSpecs } from "./cron.ts";
import { currentAllEnv, isolateProcessEnv, nodeProcessEnv } from "./env-scope.ts";
import { describeUncaught } from "./errors.ts";
import { type FunctionDef, isFunctionDef, NODE_FUNCTIONS } from "./functions.ts";
import { checkRouter, HttpRouter } from "./router.ts";

/** A pushed module, as Convex's `ModuleConfig`: its path in the functions directory, e.g. `dir/file.js`. */
export type ModuleSource = { path: string; source: string; sourceMap?: string; environment: "isolate" | "node" };

/** Convex's `AnalyzedFunction` (crates/model/src/modules/module_versions.rs), as the push reports it. */
export type AnalyzedFunction = {
  name: string;
  udfType: "Query" | "Mutation" | "Action";
  visibility: { kind: "public" | "internal" };
  /** The validator JSON of `args` / `returns` (Convex's `exportArgs()` / `exportReturns()`). */
  args: string;
  returns: string;
};
export type AnalyzedModule = {
  functions: AnalyzedFunction[];
  httpRoutes: { path: string; method: string }[] | null;
  cronSpecs: Record<string, CronSpec> | null;
};

/** A push whose modules cannot load (Convex's `InvalidModules`, 400). */
export class InvalidModulesError extends Error {
  readonly status = 400;
  readonly code = "InvalidModules";
  constructor(message: string) {
    super(`Loading the pushed modules encountered the following error:\n${message}`);
    this.name = "InvalidModulesError";
  }
}

/**
 * An error thrown by a module, as Convex reports an analyze failure: `Uncaught <Name>: <message>` and the
 * frames in the pushed code only (the server's own frames are not the app's).
 */
function uncaught(e: unknown, paths: Set<string>): string {
  const [head, ...frames] = describeUncaught(e).message.trimEnd().split("\n");
  const mine = frames.filter((f) => [...paths].some((p) => f.includes(`${p}:`)));
  return [head, ...mine].join("\n");
}

/** Convex's limits (crates/common/src/knobs.rs). */
export const MAX_USER_MODULES = 4096;
export const IMPORT_TIMEOUT_MS = 4000;

export type LoadOptions = {
  /** The deployment's import-phase seed and time (Convex's `UdfConfig`), so imports are reproducible. */
  seed: Uint32Array;
  timestamp: number;
  /** The environment variables a module sees as `process.env` outside an execution (at import). */
  env?: Record<string, string>;
  /** Called when the import reads a variable that is not set (the auth config: Convex throws then). */
  onMissingEnv?: (name: string) => void;
  importTimeoutMs?: number;
};

/** The `bunvex/*` modules a bundle leaves external, each linked to the server's own. */
const SERVER_MODULES: Record<string, () => Promise<Record<string, unknown>>> = {
  "bunvex/server": () => import("./index.ts"),
  "@bunvex/server": () => import("./index.ts"),
  "bunvex/values": () => import("@bunvex/values"),
  "@bunvex/values": () => import("@bunvex/values"),
};
const BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
  "bun",
  "bun:sqlite",
  "bun:ffi",
]);

/** A module's name as the registry keys it: its path without `.js` (`dir/file.js` → `dir/file`). */
export const moduleName = (path: string) => path.replace(/\.js$/, "");
const isDeps = (path: string) => path.startsWith("_deps/");
const sha256 = (m: ModuleSource) =>
  createHash("sha256")
    .update(m.source)
    .update(m.sourceMap ?? "")
    .digest("hex");

/** The globals of a context, besides its own JS intrinsics: the web platform Convex's runtime offers. */
function contextGlobals(node: boolean, env: Record<string, string>, onMissingEnv?: (name: string) => void) {
  const g = globalThis as Record<string, unknown>;
  const web = [
    "console",
    "URL",
    "URLSearchParams",
    "TextEncoder",
    "TextDecoder",
    "TextEncoderStream",
    "TextDecoderStream",
    "Blob",
    "File",
    "FormData",
    "Headers",
    "Request",
    "Response",
    "fetch",
    "crypto",
    "atob",
    "btoa",
    "structuredClone",
    "AbortController",
    "AbortSignal",
    "ReadableStream",
    "WritableStream",
    "TransformStream",
    "Event",
    "EventTarget",
    "queueMicrotask",
    "setTimeout",
    "clearTimeout",
    "setInterval",
    "clearInterval",
    "performance",
  ];
  const out: Record<string, unknown> = {};
  for (const k of web) out[k] = g[k];
  // The deployment's variables (STUDY-37): the execution's, else the load's.
  out.process = { env: isolateProcessEnv({ ...env }, onMissingEnv) };
  if (node) {
    for (const k of ["Buffer", "setImmediate", "clearImmediate", "global"]) out[k] = g[k];
    out.process = Object.assign(Object.create(process), { env: nodeProcessEnv({ ...env }, currentAllEnv) });
  }
  return out;
}

type Loaded = {
  source: ModuleSource;
  module: vm.SourceTextModule;
  hash: string;
};

export class CodeVersion {
  private constructor(
    /** Every module, by path. */
    readonly modules: Map<string, Loaded>,
    /** Every function, by registry key (`dir/file:name`). */
    readonly functions: Map<string, FunctionDef>,
    /** Each module's code hash, by module name. */
    readonly moduleHashes: Map<string, string>,
    readonly analysis: Record<string, AnalyzedModule>,
    readonly router: HttpRouter | undefined,
    readonly crons: Crons | undefined,
  ) {}

  /**
   * Load and analyze a push's modules. Throws `InvalidModulesError` with Convex's wording when a module
   * does not resolve, throws at import, takes too long, or exports what its file may not.
   */
  static async load(sources: ModuleSource[], opts: LoadOptions): Promise<CodeVersion> {
    // Convex's `analyze_modules` checks (application/src/lib.rs), its docs link left out (DV-04).
    const users = sources.filter((m) => !isDeps(m.path));
    if (users.length > MAX_USER_MODULES)
      throw new InvalidModulesError(
        `Too many function files (${users.length} > maximum ${MAX_USER_MODULES}) in "bunvex/".`,
      );
    // Dependencies are not the developer's, so they do not count above; but no more of them than that. A
    // system error in Convex (an internal error to the client), not an InvalidModules one.
    if (sources.length > 2 * MAX_USER_MODULES)
      throw new Error(
        `Too many dependencies modules! Dependencies: ${sources.length - users.length}, Total modules: ${sources.length}`,
      );
    const env = opts.env ?? {};
    const contexts = {
      isolate: vm.createContext(contextGlobals(false, env, opts.onMissingEnv)),
      node: vm.createContext(contextGlobals(true, env)),
    };
    for (const c of Object.values(contexts)) {
      const g = vm.runInContext("({ Date, Math })", c) as { Date: DateConstructor; Math: Math };
      installDeterminismIn(g);
      // The replaced Date goes back in as the context's global.
      vm.runInContext("(D) => { globalThis.Date = D; }", c)(g.Date);
    }

    const modules = new Map<string, Loaded>();
    for (const m of sources) {
      if (modules.has(m.path)) throw new InvalidModulesError(`Duplicate module path ${m.path}`);
      const context = contexts[m.environment];
      let module: vm.SourceTextModule;
      try {
        module = new vm.SourceTextModule(`${m.source}\n//# sourceURL=${m.path}`, { context, identifier: m.path });
      } catch (e) {
        throw new InvalidModulesError(`Failed to analyze ${m.path}: ${describeUncaught(e).message.trimEnd()}`);
      }
      modules.set(m.path, { source: m, module, hash: sha256(m) });
    }

    // The server's modules, once per context.
    const synthetic = new Map<string, vm.SyntheticModule>();
    const serverModule = async (spec: string, context: vm.Context, key: string) => {
      let s = synthetic.get(key);
      if (!s) {
        const ns =
          spec in SERVER_MODULES ? await SERVER_MODULES[spec]!() : ((await import(spec)) as Record<string, unknown>);
        const names = Object.keys(ns);
        s = new vm.SyntheticModule(
          names,
          function (this: vm.SyntheticModule) {
            for (const n of names) this.setExport(n, ns[n]);
          },
          { context, identifier: spec },
        );
        synthetic.set(key, s);
      }
      return s;
    };
    const linker = async (spec: string, referencing: vm.Module) => {
      const from = referencing.identifier;
      const env = modules.get(from)?.source.environment ?? "isolate";
      if (spec in SERVER_MODULES) return serverModule(spec, contexts[env], `${env}:${spec}`);
      if (spec.startsWith("./") || spec.startsWith("../")) {
        const path = posix.normalize(posix.join(posix.dirname(from), spec));
        const target = modules.get(path);
        if (!target)
          throw new InvalidModulesError(`Failed to analyze ${from}: Could not resolve "${spec}" (no module ${path})`);
        if (target.source.environment !== env)
          throw new InvalidModulesError(
            `Failed to analyze ${from}: it imports ${path}, which runs in the other runtime ("use node")`,
          );
        return target.module;
      }
      if (BUILTINS.has(spec) && env === "node") return serverModule(spec, contexts.node, `node:${spec}`);
      throw new InvalidModulesError(
        BUILTINS.has(spec)
          ? `Failed to analyze ${from}: "${spec}" is only available in "use node" files`
          : `Failed to analyze ${from}: Could not resolve "${spec}"`,
      );
    };

    const timeout = opts.importTimeoutMs ?? IMPORT_TIMEOUT_MS;
    for (const [path, l] of modules) {
      // Linking a module links what it imports: a shared chunk may be linked already.
      if (l.module.status !== "unlinked") continue;
      try {
        await l.module.link(linker);
      } catch (e) {
        if (e instanceof InvalidModulesError) throw e;
        throw new InvalidModulesError(`Failed to analyze ${path}: ${uncaught(e, new Set(modules.keys()))}`);
      }
    }
    for (const [path, l] of modules) {
      if (isDeps(path)) continue;
      try {
        await runImportPhase(opts.seed, opts.timestamp, () => l.module.evaluate({ timeout }));
      } catch (e) {
        throw new InvalidModulesError(`Failed to analyze ${path}: ${uncaught(e, new Set(modules.keys()))}`);
      }
    }
    return CodeVersion.analyze(modules);
  }

  /** Convex's `udf_analyze` / `http_analyze` / `cron_analyze`, over the evaluated modules. */
  private static analyze(modules: Map<string, Loaded>): CodeVersion {
    const functions = new Map<string, FunctionDef>();
    const moduleHashes = new Map<string, string>();
    const analysis: Record<string, AnalyzedModule> = {};
    let router: HttpRouter | undefined;
    let crons: Crons | undefined;
    for (const [path, l] of modules) {
      if (isDeps(path)) continue;
      const name = moduleName(path);
      moduleHashes.set(name, l.hash);
      const ns = l.module.namespace as Record<string, unknown>;
      const fns: AnalyzedFunction[] = [];
      for (const [exported, value] of Object.entries(ns)) {
        if (!isFunctionDef(value)) continue;
        if (l.source.environment === "node" && value.kind !== "action")
          throw new InvalidModulesError(
            `Failed to analyze ${path}: \`${exported}\` is a ${value.kind}, but "use node" files may only define actions`,
          );
        functions.set(`${name}:${exported}`, value);
        if (l.source.environment === "node") NODE_FUNCTIONS.add(value);
        fns.push({
          name: exported,
          udfType: value.kind === "query" ? "Query" : value.kind === "mutation" ? "Mutation" : "Action",
          visibility: { kind: value.visibility },
          args: JSON.stringify(value.args?.json ?? { type: "any" }),
          returns: JSON.stringify(value.returns?.json ?? { type: "any" }),
        });
      }
      const a: AnalyzedModule = { functions: fns, httpRoutes: null, cronSpecs: null };
      if (path === "http.js") {
        if (l.source.environment === "node")
          throw new InvalidModulesError(`Failed to analyze ${path}: \`http.js\` may not be a "use node" file`);
        if (!("default" in ns))
          throw new InvalidModulesError(
            `Failed to analyze ${path}: \`http.js\` must have a default export of a Router.`,
          );
        const r = ns.default;
        if (!(r instanceof HttpRouter) && (r as { isRouter?: unknown })?.isRouter !== true)
          throw new InvalidModulesError(
            `Failed to analyze ${path}: The default export of \`http.js\` is not a Router.`,
          );
        router = checkRouter(r);
        a.httpRoutes = router.getRoutes().map(([p, m]) => ({ path: p, method: m }));
      }
      if (path === "crons.js") {
        if (l.source.environment === "node")
          throw new InvalidModulesError(`Failed to analyze ${path}: \`crons.js\` may not be a "use node" file`);
        if (!("default" in ns))
          throw new InvalidModulesError(
            `Failed to analyze ${path}: \`crons.js\` must have a default export of a Crons object.`,
          );
        if (!(ns.default instanceof Crons))
          throw new InvalidModulesError(
            `Failed to analyze ${path}: The default export of \`crons.js\` is not a Crons object.`,
          );
        crons = ns.default;
      }
      analysis[path] = a;
    }
    const version = new CodeVersion(modules, functions, moduleHashes, analysis, router, crons);
    if (crons) {
      // Convex's `validate_cron_jobs`: every target exists and is a mutation or an action.
      const specs = cronSpecs(crons, (id, fn) => version.cronTarget(id, fn));
      analysis["crons.js"]!.cronSpecs = Object.fromEntries(specs);
    }
    return version;
  }

  /** A cron's target in this version, checked as Convex's `validate_cron_jobs`. */
  private cronTarget(identifier: string, name: string): string {
    const i = name.lastIndexOf(":");
    const [mod, fn] = i === -1 ? [moduleName(name), "default"] : [moduleName(name.slice(0, i)), name.slice(i + 1)];
    const canonical = `${mod}.js:${fn}`;
    const f = this.functions.get(`${mod}:${fn}`);
    if (!f)
      throw new InvalidModulesError(
        `The cron job '${identifier}' schedules a function that does not exist: ${canonical}`,
      );
    if (f.kind === "query")
      throw new InvalidModulesError(
        `The cron job '${identifier}' schedules a query function, only actions and mutations can be scheduled.`,
      );
    return canonical;
  }
}
