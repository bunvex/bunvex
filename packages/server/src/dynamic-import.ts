// Dynamic `import()` in a code version's modules (STUDY-188 §X14), as Convex's two runtimes answer it.
//
// - The V8 runtime resolves it in actions only (crates/isolate/src/request_scope.rs `dynamic_import_callback`,
//   installed when `allow_dynamic_imports`, which only the action and HTTP action environments set). Everywhere else
//   (a query, a mutation, the import phase) the promise rejects with `TypeError: dynamic module import unsupported`
//   (isolate.rs `error_dynamic_import_callback`, strings.rs).
//   - The specifier resolves as a URL against the importing module's (`deno_core::resolve_import`): `/`, `./` and
//     `../` against its path, anything else must be an absolute URL of the runtime's own scheme.
//   - The path is looked up in the version's modules with `.js` added when it has no extension
//     (sync_types/module_path.rs `canonicalize`); a missing one rejects with `ModuleNotFoundError`'s message
//     (model/modules/user_error.rs), naming the path as resolved, and ending with the newline of a `JsError`'s display.
//   - A module found is evaluated (once: the namespace is the same for every import), and a module that throws while
//     loading fails the action, even inside `try` (Q3, measured on its backend; the evaluation's own promise is left
//     rejected).
//   - Another scheme (`node:fs`, `https:`) fails the action too: `eval_user_module` returns that error to the run.
// - A `"use node"` module runs under Node's loader on Convex's executor: relative paths name files exactly, as bundled
//   (`_deps/node/` chunks and the `"use node"` modules), builtins and external packages resolve as a static import
//   does, a missing one rejects with Node's `ERR_MODULE_NOT_FOUND`, and a module that throws while loading rejects the
//   import, as JavaScript does.
//
// bunvex evaluates a version's modules once, in its context (DV-164), not once per run: a module only a dynamic import
// reaches (a chunk under `_deps/`) is evaluated by the first import, and every later one gets the same namespace, or
// the same error.
import { posix } from "node:path";
import vm from "node:vm";
import { inExecution } from "@bunvex/core";
import { currentActionLife, failRunningAction } from "./action-timeout.ts";
import { ExecutorFailure } from "./errors.ts";

/** The scheme a module's URL has, as Convex's `convex:` (the function tester's modules have it too). */
const SCHEME = "bunvex";

/** A module of the version, by path. */
type VersionModule = { source: { path: string; environment: "isolate" | "node" }; module: vm.Module };

export type DynamicImportHost = {
  /** Every module of the version, by path. */
  modules: ReadonlyMap<string, VersionModule>;
  /** A `"use node"` module's import of a builtin or an external package, as its static import resolves it. */
  nodeExternal: (spec: string) => Promise<vm.Module | null>;
};

type Realm = { Error: ErrorConstructor; TypeError: TypeErrorConstructor };

/** The pending or settled evaluation each module's first dynamic import started. */
const evaluations = new WeakMap<vm.Module, Promise<unknown>>();

/** `m` evaluated (its namespace then complete), or what its evaluation threw. */
async function evaluated(m: vm.Module): Promise<vm.Module> {
  // A builtin's or package's synthetic module no static import reached is not linked yet: it imports nothing.
  if (m.status === "unlinked") await m.link(() => Promise.reject(new Error("a synthetic module imports nothing")));
  if (m.status !== "evaluated" && m.status !== "errored") {
    let p = evaluations.get(m);
    if (!p) {
      p = m.evaluate();
      evaluations.set(m, p);
    }
    await p;
  }
  if (m.status === "errored") throw m.error;
  return m;
}

const RELATIVE = /^\.{0,2}\//;

/**
 * The `importModuleDynamically` of a version's module running in `context` (`environment`'s), errors made in that
 * context's realm so the app's `instanceof` holds.
 */
export function dynamicImporter(
  environment: "isolate" | "node",
  context: vm.Context,
  host: DynamicImportHost,
): (spec: string, referrer: vm.Module) => Promise<vm.Module> {
  let realm: Realm | undefined;
  const intrinsics = () => {
    realm ??= vm.runInContext("({ Error, TypeError })", context) as Realm;
    return realm;
  };
  return environment === "isolate"
    ? (spec, referrer) => isolateImport(spec, referrer.identifier, intrinsics(), host)
    : (spec, referrer) => nodeImport(spec, referrer.identifier, intrinsics(), host);
}

async function isolateImport(spec: string, from: string, realm: Realm, host: DynamicImportHost): Promise<vm.Module> {
  if (inExecution() || currentActionLife() === null) throw new realm.TypeError("dynamic module import unsupported");
  const base = `${SCHEME}:/${from}`;
  let url: URL;
  if (RELATIVE.test(spec)) url = new URL(spec, base);
  else {
    try {
      url = new URL(spec);
    } catch {
      throw new realm.Error(`Relative import path "${spec}" not prefixed with / or ./ or ../ from "${base}"`);
    }
  }
  if (url.protocol !== `${SCHEME}:`) {
    const e = new realm.Error(`Unsupported scheme (${url.protocol.slice(0, -1)}) in ${url.href}`);
    failRunningAction(e);
    throw e;
  }
  const path = url.pathname.slice(1);
  const ext = posix.extname(path);
  if (path === "") throw new realm.Error(`Invalid module path '${path}': Module path doesn't have a filename.\n`);
  if (ext !== "" && ext !== ".js")
    throw new realm.Error(`Invalid module path '${path}': Module path has an extension that isn't 'js'.\n`);
  const target = host.modules.get(ext === "" ? `${path}.js` : path);
  if (!target)
    throw new realm.Error(`Couldn't find JavaScript module '${path}'. Did you forget to run \`bunvex dev\`?\n`);
  if (target.source.environment !== "isolate") {
    // A system error on Convex (`ActionPhase::get_module`'s `ensure!`): the client gets the internal error.
    const e = new ExecutorFailure(`Trying to execute ${path} in the isolate, but it is bundled for node`);
    failRunningAction(e);
    throw e;
  }
  try {
    return await evaluated(target.module);
  } catch (e) {
    failRunningAction(e);
    throw e;
  }
}

async function nodeImport(spec: string, from: string, realm: Realm, host: DynamicImportHost): Promise<vm.Module> {
  const notFound = (message: string) => Object.assign(new realm.Error(message), { code: "ERR_MODULE_NOT_FOUND" });
  if (RELATIVE.test(spec)) {
    const path = spec.startsWith("/") ? posix.normalize(spec).slice(1) : posix.join(posix.dirname(from), spec);
    const target = host.modules.get(path);
    if (!target || target.source.environment !== "node")
      throw notFound(`Cannot find module '${path}' imported from ${from}`);
    return evaluated(target.module);
  }
  const external = await host.nodeExternal(spec);
  if (!external) throw notFound(`Cannot find package '${spec}' imported from ${from}`);
  return evaluated(external);
}
