// `process.env` in pushed code (STUDY-37), as Convex's runtime (udf-runtime/src/00_misc.ts, node-executor):
// each read asks the execution it belongs to — a query's or mutation's reader records the read in the read
// set; an action's is the snapshot of its start. Outside an execution (a module's import) the variables of
// the version's load are read. Only pushed code sees deployment variables (E3): embedded functions run in
// the host's own context and its real `process.env`.
import { AsyncLocalStorage } from "node:async_hooks";
import { checkEnvVarName } from "@bunvex/core";

export type EnvReader = ((name: string) => string | undefined) & {
  /**
   * What a query's or mutation's reader reads from, for the function sandbox's child (STUDY-171 §8.5): the
   * deployment's variables (the same object while none changes), then the built-ins.
   */
  variables?: { deployment: ReadonlyMap<string, string>; builtin: Record<string, string> };
};

const scope = new AsyncLocalStorage<EnvReader>();

/** Run `fn` with `read` behind `process.env`. */
export const withEnv = <T>(read: EnvReader, fn: () => T): T => scope.run(read, fn);

/** The reader behind `process.env` now (the function sandbox's host ships its variables to the child). */
export const currentEnvReader = (): EnvReader | null => scope.getStore() ?? null;

/** Convex's isolate `process.env`: reads one name at a time, lists nothing, `inspect` for printing. */
export function isolateProcessEnv(
  atLoad: Record<string, string>,
  onMissing?: (name: string) => void,
): Record<string, string | undefined> {
  return new Proxy({} as Record<string, string | undefined>, {
    get(_, prop) {
      if (typeof prop !== "string") return undefined;
      if (prop === "inspect") return () => "[process.env]";
      const read = scope.getStore();
      if (read) return read(prop);
      checkEnvVarName(prop);
      if (atLoad[prop] === undefined) onMissing?.(prop);
      return atLoad[prop];
    },
    has(_, prop) {
      if (typeof prop !== "string") return false;
      const read = scope.getStore();
      return (read ? read(prop) : atLoad[prop]) !== undefined;
    },
  });
}

/** What a `"use node"` action keeps of the process's own environment (Convex's node executor). */
const NODE_ALLOWLIST = ["PATH", "PWD", "LANG", "NODE_PATH", "TZ", "UTC"];

/**
 * Convex's node `process.env`: an object of the allowlisted process variables plus the deployment's, which
 * can be listed. The deployment's come from the execution (its start's snapshot), else the load.
 */
export function nodeProcessEnv(
  atLoad: Record<string, string>,
  all: () => Record<string, string> | null,
): Record<string, string | undefined> {
  const base = () => {
    const out: Record<string, string> = {};
    for (const k of NODE_ALLOWLIST) if (process.env[k] !== undefined) out[k] = process.env[k]!;
    return Object.assign(out, all() ?? atLoad);
  };
  return new Proxy({} as Record<string, string | undefined>, {
    get: (_, prop) => (typeof prop === "string" ? base()[prop] : undefined),
    has: (_, prop) => typeof prop === "string" && prop in base(),
    ownKeys: () => Object.keys(base()).sort(),
    getOwnPropertyDescriptor: (_, prop) => {
      const b = base();
      return typeof prop === "string" && prop in b
        ? { value: b[prop], writable: true, enumerable: true, configurable: true }
        : undefined;
    },
  });
}

/** For a node context: every deployment variable of the current execution, when it has them all. */
const allScope = new AsyncLocalStorage<Record<string, string>>();
export const withAllEnv = <T>(vars: Record<string, string>, read: EnvReader, fn: () => T): T =>
  allScope.run(vars, () => scope.run(read, fn));
export const currentAllEnv = () => allScope.getStore() ?? null;

let packageEnvInstalled = false;
/**
 * External packages (STUDY-148) run in the server's realm, where `process.env` is the server's own. As Convex's
 * packages read the action's variables, the server's `process.env` reads, while an action (or a package's import) is
 * in scope, that execution's deployment variables first, then the server's own (DV-472, option C). Installed once,
 * by the first code version with external packages; outside an execution nothing changes.
 */
function installPackageEnv() {
  if (packageEnvInstalled) return;
  packageEnvInstalled = true;
  const real = process.env;
  const own = (p: string | symbol): string | undefined => {
    const vars = allScope.getStore();
    return typeof p === "string" && vars && Object.hasOwn(vars, p) ? vars[p] : undefined;
  };
  process.env = new Proxy(real, {
    get: (t, p) => own(p) ?? Reflect.get(t, p),
    // Bun 1.4.4 rejects an assignment that lands on the proxy itself (`process.env` only accepts a
    // configurable, writable, enumerable data descriptor). Write the real environment.
    set: (t, p, value) => Reflect.set(t, p, value),
    has: (t, p) => own(p) !== undefined || Reflect.has(t, p),
    ownKeys: (t) => {
      const vars = allScope.getStore();
      const keys = Reflect.ownKeys(t);
      return vars ? [...new Set([...Object.keys(vars), ...keys])] : keys;
    },
    getOwnPropertyDescriptor: (t, p) => {
      const value = own(p);
      return value !== undefined
        ? { value, writable: true, enumerable: true, configurable: true }
        : Reflect.getOwnPropertyDescriptor(t, p);
    },
  });
}

/** Run `fn` (an external package's import) with the deployment's variables `vars` in the server's `process.env`. */
export const withPackageEnv = <T>(vars: Record<string, string>, fn: () => T): T => {
  installPackageEnv();
  return allScope.run(vars, fn);
};

/** Whether the server's `process.env` reads the executions' variables (the first external package installed it). */
export const packageEnvInstalledYet = () => packageEnvInstalled;
