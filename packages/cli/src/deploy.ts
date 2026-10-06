// `bunvex deploy` (STUDY-35): bundle the functions directory and push it to a self-hosted deployment over
// Convex's deploy2 protocol — get_config_hashes, start_push, wait_for_schema, finish_push.
//
// Where (owner decisions, 2026-10-02): the functions directory is `bunvex/` unless `bunvex.json` says
// `{ "functions": "…" }`; the deployment is `--url` / `--admin-key`, else BUNVEX_SELF_HOSTED_URL /
// BUNVEX_SELF_HOSTED_ADMIN_KEY, read from the environment, then `.env.local`, then `.env` (as Convex's CLI
// reads CONVEX_SELF_HOSTED_*).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { argumentError, invalidChoice, missingArgument, optionsIn, tooManyArguments, unknownOption } from "./args.ts";
import { BundleError, bundleFunctions, type ModuleConfig } from "./bundle.ts";
import {
  type CodegenConfig,
  printTypecheckFailure,
  runCodegen,
  type TypecheckMode,
  type TypescriptCompiler,
  typecheck,
} from "./codegen.ts";
import {
  type CheckMode,
  checkLargeIndexBackfill,
  checkLargeIndexDeletion,
  checkSlowSchemaValidation,
  defaultDeployMessage,
  type IndexDiff,
  PushCanceled,
  printIndexDiff,
  type SchemaEvaluation,
} from "./index-checks.ts";
import type { Io } from "./io.ts";
import { acquireTarget, urlVariables } from "./local-deployment.ts";
import { NO_DEPLOYMENT, TARGET_OPTIONS, type Target, type TargetFlags, takeTargetFlags } from "./target.ts";
import { VERSION } from "./version.ts";

export { parseEnvFile } from "./target.ts";

export const DEPLOY_USAGE = `Usage: bunvex deploy [options]

Bundle the functions directory and push it to a self-hosted deployment.

Options:
${TARGET_OPTIONS}
  --dry-run            analyze the push without changing the deployment
  --message <message>  a message to attach to this deployment in the audit log (default: the CI platform
                       and commit, when one is detected)
  --skip-large-indexes-check
                       skip the confirmation when this push creates, changes or deletes an index on a large
                       table (creating or changing one blocks the deploy until it is backfilled; consider
                       staging it instead so it backfills in the background)
  --codegen <mode>     enable (default) or disable: regenerate _generated/
  --typecheck <mode>   enable, try (default) or disable: typecheck the functions before finishing the push
  --cmd <command>      a command to run first, as part of deploying your app (e.g. \`vite build\`), with the
                       deployment's URL in an environment variable (see --cmd-url-env-var-name)
  --cmd-url-env-var-name <name>
                       the variable that gets the deployment's URL when using --cmd (e.g. VITE_BUNVEX_URL;
                       default: the one your framework reads)

The functions directory is bunvex/, or "functions" in bunvex.json.`;

export type ProjectConfig = {
  functions?: string;
  codegen?: { fileType?: "ts" | "js/dts" };
  /** Convex's `typescriptCompiler`: the typecheck's compiler (STUDY-117). */
  typescriptCompiler?: TypescriptCompiler;
  /** Convex's `generateCommonJSApi`: codegen also writes the CommonJS api (STUDY-116). */
  generateCommonJSApi?: boolean;
};

/** How Convex's schema validator (zod) names a value's type in "Expected …, received …". */
function receivedType(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number" && Number.isNaN(v)) return "nan";
  return typeof v;
}

/**
 * Read and check `bunvex.json`, as Convex's `readProjectConfig` / `parseProjectConfig` (cli/lib/config.ts) check
 * `convex.json`: JSON that does not parse is `Parsing "<path>" failed` with the parse error; anything but an
 * object is "Expected `bunvex.json` to contain an object"; a field of the wrong type names its path, as zod's
 * first issue does. Only the keys bunvex reads are checked; the others are left alone.
 */
export function readProjectConfig(cwd: string): ProjectConfig {
  const configPath = join(cwd, "bunvex.json");
  if (!existsSync(configPath)) return {};
  let config: unknown;
  try {
    config = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (e) {
    throw new Error(`Parsing "bunvex.json" failed\n${String(e)}`);
  }
  if (typeof config !== "object" || config === null || Array.isArray(config))
    throw new Error("Expected `bunvex.json` to contain an object");
  const issue = (path: string, message: string) => new Error(`\`${path}\` in \`bunvex.json\`: ${message}`);
  const { functions, codegen, typescriptCompiler, generateCommonJSApi } = config as Record<string, unknown>;
  if (functions !== undefined && typeof functions !== "string")
    throw issue("functions", `Expected string, received ${receivedType(functions)}`);
  if (codegen !== undefined) {
    if (typeof codegen !== "object" || codegen === null || Array.isArray(codegen))
      throw issue("codegen", `Expected object, received ${receivedType(codegen)}`);
    const { fileType } = codegen as Record<string, unknown>;
    if (fileType !== undefined && fileType !== "ts" && fileType !== "js/dts")
      throw issue(
        "codegen.fileType",
        typeof fileType === "string"
          ? `Invalid enum value. Expected 'ts' | 'js/dts', received '${fileType}'`
          : `Expected 'ts' | 'js/dts', received ${receivedType(fileType)}`,
      );
  }
  if (typescriptCompiler !== undefined && typescriptCompiler !== "tsc" && typescriptCompiler !== "tsgo")
    throw issue(
      "typescriptCompiler",
      typeof typescriptCompiler === "string"
        ? `Invalid enum value. Expected 'tsc' | 'tsgo', received '${typescriptCompiler}'`
        : `Expected 'tsc' | 'tsgo', received ${receivedType(typescriptCompiler)}`,
    );
  if (generateCommonJSApi !== undefined && typeof generateCommonJSApi !== "boolean")
    throw issue("generateCommonJSApi", `Expected boolean, received ${receivedType(generateCommonJSApi)}`);
  // Convex's refinement, checked once the fields are valid.
  if (generateCommonJSApi === true && (codegen as ProjectConfig["codegen"])?.fileType === "ts")
    throw issue(
      "generateCommonJSApi",
      'Cannot use `generateCommonJSApi: true` with `codegen.fileType: "ts"`. CommonJS modules require JavaScript generation. Either set `codegen.fileType: "js/dts"` or remove `generateCommonJSApi`.',
    );
  return config as ProjectConfig;
}

export function functionsDir(cwd: string): string {
  const { functions } = readProjectConfig(cwd);
  return resolve(cwd, functions ?? "bunvex");
}

/** The typecheck's compiler: bunvex.json's `typescriptCompiler`, else `tsc` (Convex's `resolveTypescriptCompiler`). */
export function typescriptCompilerOf(cwd: string): TypescriptCompiler {
  return readProjectConfig(cwd).typescriptCompiler ?? "tsc";
}

/**
 * bunvex.json's `codegen` (Convex's `codegen.fileType`: `.js` + `.d.ts` pairs by default, or `.ts`) and
 * `generateCommonJSApi`.
 */
export function codegenConfig(cwd: string): CodegenConfig {
  const config = readProjectConfig(cwd);
  const fileType = config.codegen?.fileType ?? "js/dts";
  return { fileType, packages: packagesOf(cwd), commonjs: config.generateCommonJSApi === true };
}

/** Which bunvex the app installs (STUDY-40): `bunvex`, else the scoped `@bunvex/*` packages; `bunvex` by default. */
function packagesOf(cwd: string): CodegenConfig["packages"] {
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as Record<string, Record<string, unknown>>;
    const deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
    if ("bunvex" in deps) return "bunvex";
    if (Object.keys(deps).some((d) => d.startsWith("@bunvex/"))) return "@bunvex";
  } catch {
    // no package.json
  }
  return "bunvex";
}

const sha256 = (m: ModuleConfig) =>
  createHash("sha256")
    .update(m.source)
    .update(m.sourceMap ?? "")
    .digest("hex");

// As Convex's partitionModulesByChanges: a module whose hash and runtime match the deployed one travels as
// its hash only.
export function partitionModules(
  modules: ModuleConfig[],
  remote: { path: string; hash: string; environment: string }[],
) {
  const byPath = new Map(remote.map((h) => [h.path, h]));
  const same = (m: ModuleConfig) => {
    const h = byPath.get(m.path);
    return !!h && h.hash === sha256(m) && h.environment === m.environment;
  };
  return {
    changedModules: modules.filter((m) => !same(m)),
    unchangedModuleHashes: modules
      .filter(same)
      .map((m) => ({ path: m.path, environment: m.environment, sha256: sha256(m) })),
  };
}

type Flags = TargetFlags & {
  dryRun: boolean;
  message?: string;
  skipLargeIndexesCheck: boolean;
  allowDeletingLargeIndexes: boolean;
  codegen: boolean;
  typecheck: TypecheckMode;
  cmd?: string;
  cmdUrlEnvVarName?: string;
};
function parseFlags(all: string[]): Flags | string {
  const taken = takeTargetFlags(all);
  if (typeof taken === "string") return taken;
  const args = taken.rest;
  const f: Flags = {
    ...taken.flags,
    dryRun: false,
    codegen: true,
    typecheck: "try",
    skipLargeIndexesCheck: false,
    allowDeletingLargeIndexes: false,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const [name, inline] = a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a, undefined];
    if (name === "--dry-run") f.dryRun = true;
    else if (name === "--skip-large-indexes-check") f.skipLargeIndexesCheck = true;
    // Its predecessor, hidden as in Convex: it skips the deletion confirmation only.
    else if (name === "--allow-deleting-large-indexes") f.allowDeletingLargeIndexes = true;
    else if (name === "--message") {
      const v = inline ?? args[++i];
      if (v === undefined) return missingArgument("--message <message>");
      f.message = v;
    } else if (name === "--cmd" || name === "--cmd-url-env-var-name") {
      const v = inline ?? args[++i];
      if (v === undefined)
        return missingArgument(name === "--cmd" ? "--cmd <command>" : "--cmd-url-env-var-name <name>");
      if (name === "--cmd") f.cmd = v;
      else f.cmdUrlEnvVarName = v;
    } else if (name === "--codegen" || name === "--typecheck") {
      const v = inline ?? args[++i];
      const spec = `${name} <mode>`;
      if (v === undefined) return missingArgument(spec);
      if (name === "--codegen") {
        if (v !== "enable" && v !== "disable") return invalidChoice(spec, v, ["enable", "disable"]);
        f.codegen = v === "enable";
      } else {
        if (v !== "enable" && v !== "try" && v !== "disable")
          return invalidChoice(spec, v, ["enable", "try", "disable"]);
        f.typecheck = v;
      }
    } else if (a.startsWith("-")) return unknownOption(a, optionsIn(DEPLOY_USAGE));
    else return tooManyArguments("deploy", 0, args.filter((x) => !x.startsWith("-")).length);
  }
  return f;
}

export async function deployCommand(args: string[], io: Io): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    io.out(DEPLOY_USAGE);
    return 0;
  }
  const flags = parseFlags(args);
  // Convex's `deploy` shows its help after an argument error.
  if (typeof flags === "string") return argumentError(io, flags, DEPLOY_USAGE);
  let acquired: Awaited<ReturnType<typeof acquireTarget>>;
  try {
    acquired = await acquireTarget(flags, io);
  } catch (e) {
    io.err(`bunvex deploy: ${(e as Error).message}`);
    return 1;
  }
  if (!acquired) {
    io.err(`bunvex deploy: ${NO_DEPLOYMENT}`);
    return 1;
  }
  try {
    // Convex's step 1: the build command first, with the deployment's URLs in the environment (STUDY-81).
    if (flags.cmd !== undefined && !(await runCommand(acquired.target, flags.cmd, flags, io))) return 1;
    // As Convex's `deploy`: the large-index checks ask unless a flag allows it; the message defaults to the
    // CI platform and commit.
    const message = flags.message ?? defaultDeployMessage(io.env) ?? undefined;
    return (
      await deploy(
        acquired.target,
        {
          ...flags,
          ...(message === undefined ? {} : { message }),
          largeIndexDeletionCheck:
            flags.skipLargeIndexesCheck || flags.allowDeletingLargeIndexes
              ? "has confirmation"
              : "ask for confirmation",
          largeIndexBackfillCheck: flags.skipLargeIndexesCheck ? "has confirmation" : "ask for confirmation",
          warnOnSlowSchemaValidation: true,
        },
        io,
      )
    ).code;
  } finally {
    await acquired.release();
  }
}

/**
 * Convex's `runCommand` (STUDY-81): run `cmd` in a shell, from the project, with the deployment's canonical
 * URLs in the variables the framework reads (or `--cmd-url-env-var-name` for the first). Whether it succeeded;
 * a dry run only says what it would run.
 */
async function runCommand(
  target: Target,
  cmd: string,
  flags: { dryRun: boolean; cmdUrlEnvVarName?: string },
  io: Io,
): Promise<boolean> {
  const suggested = urlVariables(io.cwd);
  const urlVar = flags.cmdUrlEnvVarName ?? suggested.url;
  const siteVar = suggested.site;
  const vars = `environment variables "${urlVar}" and "${siteVar}" set`;
  io.err(`Running '${cmd}' with ${vars}...${flags.dryRun ? " [dry run]" : ""}`);
  if (!flags.dryRun) {
    let urls: { bunvexCloudUrl?: string; bunvexSiteUrl?: string | null };
    try {
      const r = await fetch(`${target.url}/api/v1/get_canonical_urls`, {
        headers: { authorization: `Bunvex ${target.adminKey}` },
      });
      if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`);
      urls = (await r.json()) as typeof urls;
    } catch (e) {
      io.err(`bunvex deploy: could not read the deployment's URLs: ${(e as Error).message}`);
      return false;
    }
    const env: Record<string, string | undefined> = { ...process.env, ...io.env };
    if (urls.bunvexCloudUrl) env[urlVar] = urls.bunvexCloudUrl;
    if (urls.bunvexSiteUrl) env[siteVar] = urls.bunvexSiteUrl;
    const result = spawnSync(cmd, { cwd: io.cwd, env, stdio: "inherit", shell: true });
    if (result.status !== 0) {
      io.err(`bunvex deploy: '${cmd}' failed`);
      return false;
    }
  }
  io.out(`✔ ${flags.dryRun ? "Would have run" : "Ran"} "${cmd}" with ${vars}`);
  return true;
}

/**
 * `message`: attached to the push's audit-log event (Convex's `--message`). The checks before the push
 * (STUDY-56): `bunvex deploy` asks before deleting or blocking on large indexes; `bunvex dev` does not.
 */
export type DeployOptions = {
  dryRun: boolean;
  codegen: boolean;
  typecheck: TypecheckMode;
  message?: string;
  largeIndexDeletionCheck?: CheckMode;
  largeIndexBackfillCheck?: CheckMode;
  warnOnSlowSchemaValidation?: boolean;
};
/**
 * The exit code; whether a failure is worth retrying (`bunvex dev`'s backoff); whether the deployment failed on
 * its own side (its log may say why); and whether it waits on the deployment's environment variables
 * (`bunvex dev` pushes again once they change, as Convex's).
 */
export type DeployResult = {
  code: number;
  transient?: boolean;
  internal?: boolean;
  envVars?: boolean;
  /** Schema validation failed on a document of this table. */
  table?: string;
};

/** A deployment's error answer: its message and its code (Convex's `ErrorData`). */
class DeploymentError extends Error {
  constructor(
    message: string,
    readonly code: string | undefined,
  ) {
    super(message);
  }
}

/** One deploy (`bunvex deploy`, each push of `bunvex dev`). */
/**
 * `evaluate_schema` (STUDY-56), or null when the deployment has no such route. While the deployment is still
 * building its table summaries it answers 503 `TableSummariesUnavailable`: retried, as Convex's CLI retries.
 */
async function evaluateSchema(
  post: (path: string, body: object) => Promise<Record<string, unknown>>,
  request: object,
): Promise<SchemaEvaluation | null> {
  for (let attempt = 0; ; attempt++) {
    try {
      return (await post("/api/deploy2/evaluate_schema", request)) as unknown as SchemaEvaluation;
    } catch (e) {
      const m = (e as Error).message;
      if (/no route for/.test(m)) return null;
      if (/Table summary unavailable/.test(m) && attempt < 20) {
        await Bun.sleep(500);
        continue;
      }
      throw e;
    }
  }
}

export async function deploy(target: Target, flags: DeployOptions, io: Io): Promise<DeployResult> {
  const { url, adminKey } = target;
  let bundled: Awaited<ReturnType<typeof bundleFunctions>>;
  let dir: string;
  let codegen: CodegenConfig;
  try {
    dir = functionsDir(io.cwd);
    codegen = codegenConfig(io.cwd);
    // Convex's initial codegen: what modules importing `_generated/` need to bundle.
    if (flags.codegen && existsSync(dir)) runCodegen(dir, codegen, { initial: true });
    bundled = await bundleFunctions(dir, io.cwd);
  } catch (e) {
    io.err(`bunvex deploy: ${e instanceof BundleError ? e.message : (e as Error).message}`);
    return { code: 1 };
  }
  const post = async (path: string, body: object) => {
    let r: Response;
    try {
      r = await fetch(`${url}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bunvex ${adminKey}` },
        body: JSON.stringify({ adminKey, ...body }),
      });
    } catch (e) {
      throw new Error(`could not reach ${url}: ${(e as Error).message}`);
    }
    const text = await r.text();
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new Error(`${url}${path} answered ${r.status}: ${text.slice(0, 200)}`);
    }
    if (!r.ok)
      throw new DeploymentError(
        String(json.message ?? `${r.status} ${json.code ?? ""}`),
        typeof json.code === "string" ? json.code : undefined,
      );
    return json;
  };
  try {
    const hashes = (await post("/api/get_config_hashes", {})).moduleHashes as {
      path: string;
      hash: string;
      environment: string;
    }[];
    const { changedModules, unchangedModuleHashes } = partitionModules(bundled.modules, hashes);
    const request = {
      dryRun: flags.dryRun,
      functions: "bunvex",
      appDefinition: {
        definition: null,
        dependencies: [],
        schema: bundled.schema,
        changedModules,
        unchangedModuleHashes,
        udfServerVersion: VERSION,
      },
      componentDefinitions: [],
      nodeDependencies: [],
    };
    // Convex's checks before the push, on one `evaluate_schema` (skipped against a deployment without it).
    const deletion = flags.largeIndexDeletionCheck ?? "no verification";
    const backfill = flags.largeIndexBackfillCheck ?? "no verification";
    const slow = flags.dryRun && flags.warnOnSlowSchemaValidation;
    if (deletion !== "no verification" || backfill !== "no verification" || slow) {
      const evaluation = await evaluateSchema(post, request);
      if (evaluation) {
        checkLargeIndexDeletion(io, evaluation, deletion, url);
        checkLargeIndexBackfill(
          io,
          evaluation,
          flags.dryRun && backfill !== "no verification" ? "warn" : backfill,
          url,
        );
        if (slow) checkSlowSchemaValidation(io, evaluation);
      }
    }
    const start = await post("/api/deploy2/start_push", request);
    // Convex's final codegen and typecheck, after the push is analyzed and before it is finished.
    if (flags.codegen) runCodegen(dir, codegen);
    const checked = await typecheck(dir, io.cwd, flags.typecheck, typescriptCompilerOf(io.cwd));
    if (!checked.ok) {
      printTypecheckFailure(io, checked);
      return { code: 1 };
    }
    if (checked.skipped && checked.skipped !== "disabled") io.err(checked.skipped);
    if (checked.warning) io.err(checked.warning);
    // Convex prints the diff from `start_push`'s answer, else `finish_push`'s.
    const startDiff = (start.schemaChange as { indexDiffs?: Record<string, IndexDiff> } | undefined)?.indexDiffs?.[""];
    if (flags.dryRun) {
      if (startDiff) printIndexDiff(io, startDiff, true);
      const fns = Object.values(
        (start.analysis as Record<string, { functions: Record<string, { functions: unknown[] }> }>)[""]!.functions,
      );
      io.out(
        `Dry run: ${bundled.modules.length} modules, ${fns.reduce((n, m) => n + m.functions.length, 0)} functions; nothing was changed.`,
      );
      return { code: 0 };
    }
    for (;;) {
      const s = await post("/api/deploy2/wait_for_schema", { schemaChange: start.schemaChange, timeoutMs: 10_000 });
      if (s.type === "complete") break;
      if (s.type === "failed") {
        // Convex's words (deploy2.ts `waitForSchema`): the failure, then the error, which names the table and
        // document. The table is what `bunvex dev` waits on before it pushes again (STUDY-120).
        io.err(`✖ Schema validation failed.\n${s.error}`);
        return typeof s.tableName === "string" ? { code: 1, table: s.tableName } : { code: 1 };
      }
      if (s.type === "raceDetected") {
        io.err("Schema was overwritten by another push.");
        return { code: 1 };
      }
      const c = (s.components as Record<string, { indexesComplete: number; indexesTotal: number }>)[""];
      io.err(
        `Backfilling indexes (${c?.indexesComplete ?? 0}/${c?.indexesTotal ?? 0} ready) and checking that documents match your schema...`,
      );
    }
    const diff = (await post("/api/deploy2/finish_push", {
      startPush: start,
      dryRun: false,
      ...(flags.message === undefined ? {} : { message: flags.message }),
    })) as {
      componentDiffs: Record<
        string,
        {
          moduleDiff: { added: string[]; removed: string[] };
          cronDiff: { added: string[]; updated: string[]; deleted: string[] };
          indexDiff: IndexDiff;
        }
      >;
    };
    void post("/api/deploy2/report_push_completed", { spans: [] }).catch(() => {});
    const d = diff.componentDiffs[""];
    const indexDiff = startDiff ?? d?.indexDiff;
    if (indexDiff) printIndexDiff(io, indexDiff, false);
    if (d) {
      for (const c of d.cronDiff.added) io.err(`  [+] cron ${c}`);
      for (const c of d.cronDiff.deleted) io.err(`  [-] cron ${c}`);
    }
    io.out(`✔ Deployed functions to ${url}`);
    return { code: 0 };
  } catch (e) {
    if (e instanceof PushCanceled) return { code: 1 };
    const message = (e as Error).message;
    // Convex's `handlePushConfigError`: the variable named, and how to set it (with no deployment dashboard
    // link to give, Convex's own words for that case).
    if (e instanceof DeploymentError && e.code === "AuthConfigMissingEnvironmentVariable") {
      const [, name] = message.match(/Environment variable (\S+)/i) ?? [];
      io.err(
        `bunvex deploy: Environment variable ${name} is used in auth config file but its value was not set.\nGo set it in the dashboard or using \`bunvex env set\``,
      );
      return { code: 1, envVars: true };
    }
    io.err(`bunvex deploy: ${message}`);
    // As Convex's CLI: an unreachable deployment and a push race are worth retrying.
    return {
      code: 1,
      transient: /^could not reach |changed during push|overwritten by another push/.test(message),
      internal: /couldn't be completed|Internal Server Error/.test(message),
    };
  }
}
