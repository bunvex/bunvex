// The function tester (STUDY-119): `POST /api/run_test_function`, Convex's `run_test_function`
// (crates/local_backend/src/dashboard.rs) and `execute_standalone_module` (crates/application/src/lib.rs).
// A single module the caller sends, loaded and analyzed alone (it may import only the server's modules, the
// function tester's builders `bunvex:/_system/repl/wrappers.js` among them), whose default export, a query,
// runs once, uncached; nothing of it is kept. `bunvex run --inline-query` and the MCP server use it.
import { CodeVersion, InvalidModulesError, type LoadOptions, moduleName } from "./code-version.ts";
import { badModulePath } from "./function-path.ts";
import type { FunctionDef, QueryDef } from "./functions.ts";

/** A request the function tester refuses: its status, code and message, as Convex's `ErrorMetadata`. */
export class TestFunctionError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "TestFunctionError";
  }
}

/** The request's `bundle` (Convex's `ModuleJson`). */
export type TestBundle = { path: string; source: string; sourceMap?: string | null; environment?: string | null };

/** The module path with `.js` when it has no extension, as Convex canonicalizes it. */
const canonical = (path: string) => (/\.[^/]*$/.test(path.split("/").at(-1)!) ? path : `${path}.js`);

/**
 * The bundle's query, checked in Convex's order: the module path, the runtime, the module's analysis (alone),
 * then its functions — the default export only, and a query. Its name is the module's default export.
 */
export async function standaloneQuery(
  bundle: TestBundle,
  load: LoadOptions,
): Promise<{ name: string; query: QueryDef }> {
  const bad = badModulePath(bundle.path);
  if (bad) throw new TestFunctionError(bad.status, bad.code, bad.message);
  // `parse_module_environment`: as written, else from the path (`actions/` is Node's, Convex's old layout).
  const environment = bundle.environment ?? (bundle.path.startsWith("actions/") ? "node" : "isolate");
  if (environment !== "isolate" && environment !== "node")
    // Convex's parse error carries no metadata: an internal error.
    throw new Error(`unknown module environment ${environment}`);
  if (environment !== "isolate")
    throw new TestFunctionError(400, "InvalidTestQueryEnvironment", "Test queries must use the bunvex runtime.");
  const path = canonical(bundle.path);
  let version: CodeVersion;
  try {
    version = await CodeVersion.load(
      [{ path, source: bundle.source, environment, ...(bundle.sourceMap ? { sourceMap: bundle.sourceMap } : {}) }],
      load,
    );
  } catch (e) {
    if (e instanceof InvalidModulesError)
      throw new TestFunctionError(400, "InvalidModules", `Could not analyze the given module:\n${e.detail}`);
    throw e;
  }
  let found: { name: string; def: FunctionDef } | null = null;
  for (const [name, def] of version.functions) {
    if (!name.endsWith(":default"))
      throw new TestFunctionError(400, "InvalidTestQuery", "Only `export default` is supported.");
    found = { name, def };
  }
  if (!found) throw new TestFunctionError(400, "InvalidTestQuery", "Default export is not a bunvex function.");
  if (found.def.kind !== "query")
    throw new TestFunctionError(
      400,
      "UnsupportedTestQuery",
      `${found.def.kind === "mutation" ? "Mutations" : "Actions"} are not supported in the REPL yet.`,
    );
  return { name: `${moduleName(path)}:default`, query: found.def as QueryDef };
}
