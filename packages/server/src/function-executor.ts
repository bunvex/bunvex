// Where app code runs (STUDY-171, AD-44; designed in STUDY-168 §10 and §12): the one place a code version's
// modules are loaded, so a second executor can take over without its callers changing.
//
// - `vm` (the default): this process's `node:vm` contexts, one pair per code version (`CodeVersion.load`,
//   DV-164). Its own globals, not a security boundary.
// - `process`: app code in a separate process (STUDY-168, `@bunvex/sandbox`): its queries, mutations and actions run
//   there, each `ctx` operation answered on the host (STUDY-171 §8, §12). Without OS isolation yet (PR 8): it
//   starts only with `BUNVEX_FUNCTION_SANDBOX_ISOLATION=none`, and says so. The server cannot import the sandbox
//   (the sandbox's child runs the server's loader): its entry point provides it (`provideProcessExecutor`), and a
//   start that asks for `process` without one fails.
//
// Chosen by `BUNVEX_FUNCTION_SANDBOX` (`--function-sandbox` on `bunvex-local-backend` wins over it), the
// isolation layers of `process` by `BUNVEX_FUNCTION_SANDBOX_ISOLATION`. Both are read once, at start, and checked
// strictly, as `--deny-addresses` is: a security setting does not fall back to the default on a typo.
import type { EngineSchema } from "@bunvex/core";
import { CodeVersion, type LoadedCode, type LoadOptions, type ModuleSource } from "./code-version.ts";

export { asActionResponse } from "./action-fetch.ts";
export {
  ACTION_ENDED_MESSAGE,
  currentActionSignal,
  setActionTimerCallback,
  trackedActionTimers,
} from "./action-timeout.ts";
// What the child's calls and the host's stand-ins use (STUDY-171 §8).
export { appContext } from "./app-errors.ts";
export {
  type FunctionDef,
  REMOTE_FUNCTIONS,
  REMOTE_GATES,
  type RemoteRunner,
  type SandboxCall,
} from "./builders.ts";
// What the `process` executor's child runtime (`@bunvex/sandbox`) loads through this module: the same loader, so
// a child analyzes a push exactly as this process does (STUDY-171 §7).
export {
  type AnalyzedFunction,
  type AnalyzedModule,
  CodeVersion,
  FunctionExportError,
  IMPORT_TIMEOUT_MS,
  InvalidModulesError,
  type LoadedCode,
  type LoadOptions,
  MAX_USER_MODULES,
  type ModuleSource,
  moduleHash,
} from "./code-version.ts";
export { Crons } from "./cron.ts";
export { currentAllEnv, currentEnvReader, type EnvReader, withAllEnv, withEnv } from "./env-scope.ts";
export { ExecutorFailure } from "./errors.ts";
export { createFunctionHandle, inHandleScope } from "./function-handles.ts";
export { currentPendingOps, NODE_FUNCTIONS, vectorSearchFilter } from "./functions.ts";
export { addAuditLine, setAuditScope } from "./log.ts";
export {
  captureLines,
  collectLogs,
  type LogLevel,
  type LogLine,
  logChildLine,
  MAX_LOG_LINE_LENGTH,
  MAX_LOG_LINES,
  makeLogLine,
} from "./logs.ts";
export { type AnyRoomDef, presenceGeneric, roomGeneric } from "./rooms/define.ts";
export { HttpRouter, httpActionGeneric } from "./router.ts";
export { setServiceCallContext } from "./service-tokens.ts";
export { SpecBlob } from "./web-blob.ts";

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
export function isSchemaDefinition(value: unknown): value is EngineSchema {
  const tables = (value as EngineSchema | null)?.tables;
  return (
    typeof tables === "object" &&
    tables !== null &&
    !(tables instanceof Map) &&
    typeof (value as EngineSchema).schemaValidation === "boolean"
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

/**
 * An auth config `JSON.stringify` refuses (a bigint, a cycle): Convex's `AuthConfigUnserializableError`
 * (crates/isolate/src/environment/auth_config.rs:286-290), its docs link left out (DV-04). Only an executor that
 * sends the config as its JSON throws it (the sandbox's); `vm` hands the live value to `parseAuthConfig`.
 */
export class UnserializableAuthConfigError extends Error {
  constructor() {
    super("auth config file can only contain strings");
    this.name = "UnserializableAuthConfigError";
  }
}

/** What a function cannot use under the process sandbox yet (STUDY-171 §8.7), and how to run it. */
export const sandboxNotYet = (what: string) =>
  `${what} are not available yet under the function sandbox 'process' (BUNVEX_FUNCTION_SANDBOX=process): ` +
  "unset BUNVEX_FUNCTION_SANDBOX to run them in 'vm'";

/** An executor: loads a code version's modules, analyzed, their functions ready to run. */
export type Executor = {
  readonly kind: FunctionSandbox;
  load(sources: ModuleSource[], opts: LoadOptions): Promise<LoadedCode>;
  /**
   * A standalone module's default export, evaluated as the push's import phase evaluates modules (the auth config,
   * a schema). Throws what `load` throws, or `MissingEnvironmentVariableError`.
   */
  evaluateDefault(source: ModuleSource, opts: EvaluateOptions, use: DefaultExportUse): Promise<unknown>;
  /** `version` serves now; what this executor holds for any other version it loaded may go once it is idle. */
  installed?(version: LoadedCode): void;
  /** `version` will not be called again (the function tester's). */
  release?(version: LoadedCode): void;
  /** Stops whatever the executor runs (the server's shutdown). */
  close?(): Promise<void>;
};

/** Today's: `node:vm` contexts in this process. The live export is handed back, whatever its use. */
export const vmExecutor: Executor = {
  kind: "vm",
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

/** Load code in `executor` (the server's; `vm` by default). Every load of an app's modules goes through here. */
export const loadCode = (
  sources: ModuleSource[],
  opts: LoadOptions,
  executor: Executor = vmExecutor,
): Promise<LoadedCode> => executor.load(sources, opts);

/** Evaluate a standalone module's default export in `executor` (`Executor.evaluateDefault`). */
export const evaluateDefault = (
  source: ModuleSource,
  opts: EvaluateOptions,
  use: DefaultExportUse,
  executor: Executor = vmExecutor,
) => executor.evaluateDefault(source, opts, use);

/** Makes a server's `process` executor: each server gets its own (its children are its own). */
export type ProcessExecutorFactory = () => Executor;
let processExecutorFactory: ProcessExecutorFactory | null = null;
/**
 * Provide the `process` executor (`@bunvex/sandbox`'s `createProcessExecutor`): the server cannot import it, so the
 * entry point that starts a server does (`bunvex-local-backend`), as it provides the persistence drivers.
 */
export function provideProcessExecutor(factory: ProcessExecutorFactory | null) {
  processExecutorFactory = factory;
}

/** Throws unless the `process` executor was provided (a start checks it before its store opens). */
export function requireProcessExecutor() {
  if (!processExecutorFactory) throw new Error(PROCESS_SANDBOX_NOT_PROVIDED);
}

/** Why `process` cannot start without its executor, and the fix. */
export const PROCESS_SANDBOX_NOT_PROVIDED =
  "the function sandbox 'process' needs its executor, which this server was not given: call " +
  "provideProcessExecutor(createProcessExecutor) from @bunvex/sandbox before createServer, or unset " +
  "BUNVEX_FUNCTION_SANDBOX";

/** The executor a server runs functions in (`functionSandboxConfig` checked the choice). */
export function executorFor(sandbox: FunctionSandbox): Executor {
  if (sandbox === "vm") return vmExecutor;
  requireProcessExecutor();
  return processExecutorFactory!();
}

/** What a start under `process` logs: the isolation it runs with (STUDY-171 §8.8). */
export const PROCESS_SANDBOX_WARNING =
  "the function sandbox 'process' runs queries, mutations and actions in a separate process, with no OS " +
  "isolation (BUNVEX_FUNCTION_SANDBOX_ISOLATION=none): it is not a security boundary yet. HTTP actions, " +
  '"use node" actions and components are not available under it yet';

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

/** Why `process` refuses to start with an isolation it does not have yet, and the fix. */
export const processIsolationUnavailable = (isolation: SandboxIsolation) =>
  `the function sandbox's isolation '${isolation}' is not available yet in this release: the only one is 'none', ` +
  "which runs functions in a separate process with no OS isolation (not a security boundary). Set " +
  "BUNVEX_FUNCTION_SANDBOX_ISOLATION=none, or unset BUNVEX_FUNCTION_SANDBOX and --function-sandbox to run them in 'vm'";

/**
 * The executor a start asks for, checked before anything starts: both values valid, and the executor available
 * on this host. Throws otherwise, with the fix in the message (owner, 2026-10-19: fail at start).
 */
export function functionSandboxConfig(
  sandbox: string | undefined,
  isolation: string | undefined,
): { sandbox: FunctionSandbox; isolation: SandboxIsolation } {
  const config = { sandbox: functionSandbox(sandbox), isolation: sandboxIsolation(isolation) };
  // No OS layer exists yet (STUDY-168 PR 8): an operator who asked for one (`auto` included) never silently runs
  // without it; `none` is the explicit downgrade (owner, 2026-10-19: fail at start). No Windows (AD-44).
  if (config.sandbox === "process" && config.isolation !== "none")
    throw new Error(processIsolationUnavailable(config.isolation));
  if (config.sandbox === "process" && process.platform === "win32")
    throw new Error("the function sandbox 'process' is not supported on Windows: unset BUNVEX_FUNCTION_SANDBOX");
  return config;
}
