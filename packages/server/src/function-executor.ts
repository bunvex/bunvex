// Where app code runs (STUDY-171, AD-44; designed in STUDY-168 §10 and §12): the one place a code version's
// modules are loaded, so a second executor can take over without its callers changing.
//
// - `vm` (the default): this process's `node:vm` contexts, one pair per code version (`CodeVersion.load`,
//   DV-164). Its own globals, not a security boundary.
// - `process`: app code in a separate, OS-sandboxed process, one call per process (STUDY-168). Not built yet:
//   asking for it fails at start, never a silent `vm`.
//
// Chosen by `BUNVEX_FUNCTION_SANDBOX` (`--function-sandbox` on `bunvex-local-backend` wins over it), the
// isolation layers of `process` by `BUNVEX_FUNCTION_SANDBOX_ISOLATION`. Both are read once, at start, and checked
// strictly, as `--deny-addresses` is: a security setting does not fall back to the default on a typo.
import { CodeVersion, type LoadOptions, type ModuleSource } from "./code-version.ts";

export type FunctionSandbox = "vm" | "process";
export const FUNCTION_SANDBOXES: readonly FunctionSandbox[] = ["vm", "process"];
export const DEFAULT_FUNCTION_SANDBOX: FunctionSandbox = "vm";

/** The layers `process` builds its wall from (STUDY-168 §10.2, §11): `auto` picks the strongest the host has. */
export type SandboxIsolation = "auto" | "namespaces" | "landlock" | "none";
export const SANDBOX_ISOLATIONS: readonly SandboxIsolation[] = ["auto", "namespaces", "landlock", "none"];
export const DEFAULT_SANDBOX_ISOLATION: SandboxIsolation = "auto";

/** An executor: loads a code version's modules, analyzed, their functions ready to run. */
export type Executor = { load(sources: ModuleSource[], opts: LoadOptions): Promise<CodeVersion> };

/** Today's: `node:vm` contexts in this process. */
export const vmExecutor: Executor = { load: (sources, opts) => CodeVersion.load(sources, opts) };

/** Load code in the executor. Every load of an app's modules goes through here; `vm` is the only one so far. */
export const loadCode = (sources: ModuleSource[], opts: LoadOptions): Promise<CodeVersion> =>
  vmExecutor.load(sources, opts);

function oneOf<T extends string>(value: string | undefined, values: readonly T[], def: T, what: string): T {
  if (value === undefined || value === "") return def;
  if (!(values as readonly string[]).includes(value))
    throw new Error(`invalid value '${value}' for ${what}: possible values: ${values.join(", ")}`);
  return value as T;
}

/** `functionSandbox` / `BUNVEX_FUNCTION_SANDBOX` / `--function-sandbox`, checked; the default when unset. */
export const functionSandbox = (value: string | undefined): FunctionSandbox =>
  oneOf(value, FUNCTION_SANDBOXES, DEFAULT_FUNCTION_SANDBOX, "the function sandbox (BUNVEX_FUNCTION_SANDBOX)");

/** `functionSandboxIsolation` / `BUNVEX_FUNCTION_SANDBOX_ISOLATION`, checked; the default when unset. */
export const sandboxIsolation = (value: string | undefined): SandboxIsolation =>
  oneOf(
    value,
    SANDBOX_ISOLATIONS,
    DEFAULT_SANDBOX_ISOLATION,
    "the function sandbox's isolation (BUNVEX_FUNCTION_SANDBOX_ISOLATION)",
  );

/** Why `process` refuses to start, and the fix. */
export const PROCESS_SANDBOX_UNAVAILABLE =
  "the function sandbox 'process' is not available yet in this release: functions run in 'vm' only. " +
  "Unset BUNVEX_FUNCTION_SANDBOX and --function-sandbox, or set them to 'vm'";

/**
 * The executor a start asks for, checked before anything starts: both values valid, and the executor available
 * on this host. Throws otherwise, with the fix in the message (owner, 2026-10-19: fail at start).
 */
export function functionSandboxConfig(
  sandbox: string | undefined,
  isolation: string | undefined,
): { sandbox: FunctionSandbox; isolation: SandboxIsolation } {
  const config = { sandbox: functionSandbox(sandbox), isolation: sandboxIsolation(isolation) };
  if (config.sandbox === "process") throw new Error(PROCESS_SANDBOX_UNAVAILABLE);
  return config;
}
