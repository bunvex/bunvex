// `process.env` in pushed code (STUDY-37), as Convex's runtime (udf-runtime/src/00_misc.ts, node-executor):
// each read asks the execution it belongs to — a query's or mutation's reader records the read in the read
// set; an action's is the snapshot of its start. Outside an execution (a module's import) the variables of
// the version's load are read. Only pushed code sees deployment variables (E3): embedded functions run in
// the host's own context and its real `process.env`.
import { AsyncLocalStorage } from "node:async_hooks";
import { checkEnvVarName } from "@bunvex/core";

export type EnvReader = (name: string) => string | undefined;

const scope = new AsyncLocalStorage<EnvReader>();

/** Run `fn` with `read` behind `process.env`. */
export const withEnv = <T>(read: EnvReader, fn: () => T): T => scope.run(read, fn);

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
