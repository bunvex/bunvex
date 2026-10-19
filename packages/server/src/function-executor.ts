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
import type { SchemaDefinition } from "@bunvex/core";
import { CodeVersion, type LoadOptions, type ModuleSource } from "./code-version.ts";

// What the `process` executor's child runtime (`@bunvex/sandbox`) loads through this module: the same loader, so
// a child analyzes a push exactly as this process does (STUDY-171 §7).
export {
  type AnalyzedFunction,
  type AnalyzedModule,
  CodeVersion,
  FunctionExportError,
  IMPORT_TIMEOUT_MS,
  InvalidModulesError,
  type LoadOptions,
  MAX_USER_MODULES,
  type ModuleSource,
} from "./code-version.ts";
export { NODE_FUNCTIONS } from "./functions.ts";

export type FunctionSandbox = "vm" | "process";
export const FUNCTION_SANDBOXES: readonly FunctionSandbox[] = ["vm", "process"];
export const DEFAULT_FUNCTION_SANDBOX: FunctionSandbox = "vm";

/** The layers `process` builds its wall from (STUDY-168 §10.2, §11): `auto` picks the strongest the host has. */
export type SandboxIsolation = "auto" | "namespaces" | "landlock" | "none";
export const SANDBOX_ISOLATIONS: readonly SandboxIsolation[] = ["auto", "namespaces", "landlock", "none"];
export const DEFAULT_SANDBOX_ISOLATION: SandboxIsolation = "auto";

/**
 * What a push evaluates a standalone module for (Convex's `evaluate_auth_config`, `evaluate_schema`), so an executor
 * that cannot hand back the live export knows which form to send: the auth config as its JSON (Convex
 * `JSON.stringify`s it in the isolate), the schema as its export (Convex calls its `export()`).
 */
export type DefaultExportUse = "authConfig" | "schema";

/** The options of a push-time evaluation (`evaluateDefault`). */
export type EvaluateOptions = {
  seed: Uint32Array;
  timestamp: number;
  env: Record<string, string>;
  /**
   * A read of a variable that is not set throws, failing the evaluation with `MissingEnvironmentVariableError`
   * (the auth config: Convex's `AuthConfigMissingEnvironmentVariable`).
   */
  failOnMissingEnv?: boolean;
};

/** A schema module's default export as `defineSchema` makes it: its tables a record of table definitions. */
export function isSchemaDefinition(value: unknown): value is SchemaDefinition {
  const tables = (value as SchemaDefinition | null)?.tables;
  return (
    typeof tables === "object" &&
    tables !== null &&
    !(tables instanceof Map) &&
    typeof (value as SchemaDefinition).schemaValidation === "boolean"
  );
}

/** An evaluation that read a variable that is not set (`failOnMissingEnv`). */
export class MissingEnvironmentVariableError extends Error {
  constructor(readonly variable: string) {
    super(missingEnvMessage(variable));
    this.name = "MissingEnvironmentVariableError";
  }
}
const missingEnvMessage = (name: string) =>
  `Environment variable ${name} is used in auth config file but its value was not set`;

/** An executor: loads a code version's modules, analyzed, their functions ready to run. */
export type Executor = {
  load(sources: ModuleSource[], opts: LoadOptions): Promise<CodeVersion>;
  /**
   * A standalone module's default export, evaluated as the push's import phase evaluates modules (the auth config,
   * a schema). Throws what `load` throws, or `MissingEnvironmentVariableError`.
   */
  evaluateDefault(source: ModuleSource, opts: EvaluateOptions, use: DefaultExportUse): Promise<unknown>;
};

/** Today's: `node:vm` contexts in this process. The live export is handed back, whatever its use. */
export const vmExecutor: Executor = {
  load: (sources, opts) => CodeVersion.load(sources, opts),
  async evaluateDefault(source, opts) {
    let missing: string | null = null;
    try {
      const v = await CodeVersion.load([source], {
        seed: opts.seed,
        timestamp: opts.timestamp,
        env: opts.env,
        ...(opts.failOnMissingEnv
          ? {
              onMissingEnv: (name: string) => {
                missing = name;
                throw new Error(missingEnvMessage(name));
              },
            }
          : {}),
      });
      return (v.modules.get(source.path)!.module.namespace as { default?: unknown }).default;
    } catch (e) {
      // The module may catch the read's error and throw another: the read still fails the evaluation.
      if (missing !== null) throw new MissingEnvironmentVariableError(missing);
      throw e;
    }
  },
};

/** Load code in the executor. Every load of an app's modules goes through here; `vm` is the only one so far. */
export const loadCode = (sources: ModuleSource[], opts: LoadOptions): Promise<CodeVersion> =>
  vmExecutor.load(sources, opts);

/** Evaluate a standalone module's default export in the executor (`Executor.evaluateDefault`). */
export const evaluateDefault = (source: ModuleSource, opts: EvaluateOptions, use: DefaultExportUse) =>
  vmExecutor.evaluateDefault(source, opts, use);

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
