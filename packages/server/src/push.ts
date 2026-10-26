// Pushing code (STUDY-35): Convex's deploy2 protocol (crates/local_backend/src/deploy_config2.rs,
// crates/application/src/deploy_config.rs), over what the engine and the code store do:
//
//   POST /api/get_config_hashes             the deployed modules' hashes, so a push sends only what changed
//   POST /api/deploy2/start_push            install the external packages (InvalidExternalModules, STUDY-148),
//                                           resolve the modules, load and analyze them (InvalidModules),
//                                           evaluate the schema (InvalidSchema) and auth.config, start the
//                                           schema change; answer the analysis and the schemaChange
//   POST /api/deploy2/wait_for_schema       long-poll the schema change (inProgress / complete / failed /
//                                           raceDetected)
//   POST /api/deploy2/finish_push           ONE commit: the schema made active with its indexes, the code
//                                           rows, the crons; then the code goes live; answer the diff
//   POST /api/deploy2/evaluate_push         a dry run's schema change
//   POST /api/deploy2/report_push_completed telemetry, accepted
//
// The pushed version waits in memory between start_push and finish_push (Convex echoes start_push's answer
// back; a restart in between makes finish_push answer RaceDetected and the CLI push again).
import { type AuthInfo, parseAuthConfig } from "@bunvex/auth";
import {
  type AuditLogActor,
  componentMeta,
  componentPath,
  declaredTables,
  documentTypeError,
  type Engine,
  type EngineSchema,
  indexReferenceError,
  insertAuditLogEvents,
  type NewComponentDefinition,
  resolveComponentPath,
  SCHEMAS_TABLE,
  SchemaPushError,
  SYSTEM_ACTOR,
  schemaStateOf,
  schemaToJson,
  stagedDocumentError,
  TooManyTablesError,
} from "@bunvex/core";
import type { BlobStore } from "@bunvex/file-storage";
import { checkValue, fromJsonValue, type JSONValue, validatorFromJson } from "@bunvex/values";
import { auditEvents, type ComponentDiff } from "./audit-log.ts";
import { putAuthInfo } from "./auth-info.ts";
import {
  AUTH_CONFIG_MODULE,
  checkPackagesSize,
  ModulesTooLargeError,
  type PackageExternalDeps,
  readablePackage,
  referencedPackageKeys,
  type SourcePackageFields,
  storedModules,
  type UdfServerVersionDiff,
  udfConfig,
  writePackage,
} from "./code-store.ts";
import {
  type AnalyzedModule,
  FunctionExportError,
  InvalidModulesError,
  type LoadedCode,
  type ModuleSource,
} from "./code-version.ts";
import {
  type CheckedComponent,
  ComponentTreeError,
  checkEnvVarDeclarations,
  componentsOf,
  type EvaluatedDefinition,
  instantiateRoot,
  serializedCheckedComponent,
} from "./component-tree.ts";
import type { CronJobExecutor } from "./cron-executor.ts";
import { DefinitionError, evaluateDefinitions } from "./definition-eval.ts";
import { describeUncaught } from "./errors.ts";
import {
  buildExternalDeps,
  cachedExternalDeps,
  ExternalDepsError,
  type ExternalDepsPackage,
  externalDepsPath,
  type NodeDependency,
} from "./external-deps.ts";
import {
  type Executor,
  evaluateDefault as evaluateDefaultExport,
  isSchemaDefinition,
  loadCode,
  MissingEnvironmentVariableError,
  UnserializableAuthConfigError,
  vmExecutor,
} from "./function-executor.ts";
import { indexAuditDiff, indexDiffJson } from "./push-audit.ts";
import {
  analysisAnswer,
  byPath,
  type ComponentDefinitionConfig,
  type ComponentsSchemaChange,
  DEFAULT_ROOT,
  type DefinitionCode,
  definitionModule,
  finishComponents,
  InvalidConfigError,
  type PushedComponents,
  parsePushedComponents,
  RaceError,
  schemaChangeAnswer,
  startComponentSchemas,
} from "./push-components.ts";

/** A push that cannot go on, as Convex's `ErrorMetadata` (400 unless said otherwise). */
/**
 * Convex's `check_index_references`, after the schema evaluates (`_evaluate_schema`): an index naming a field
 * the validator cannot hold is a 400 `SchemaDefinitionError`, wrapped as every schema error is.
 */
/** Convex's `invalid_schema_export_error`, without Convex's name or docs link (DV-356). */
const invalidSchemaExport = () =>
  new PushError(
    "InvalidSchemaExport",
    "Hit an error while evaluating your schema:\nDefault export from schema file isn't a bunvex schema.",
  );

/**
 * The schema module's default export, as Convex's `run_evaluate_schema` takes it (crates/isolate/src/environment/
 * schema.rs): none, `null` or `undefined` is `MissingSchemaExportError`; anything that is not a schema (made by
 * `defineSchema`) is `InvalidSchemaExport`. Convex's messages without its docs link (DV-356).
 */
function schemaExport(value: unknown): EngineSchema {
  if (value === undefined || value === null)
    throw new PushError(
      "MissingSchemaExportError",
      "Hit an error while evaluating your schema:\nSchema file missing default export.",
    );
  if (!isSchemaDefinition(value)) throw invalidSchemaExport();
  return value as EngineSchema;
}

function checkIndexReferences(schema: EngineSchema) {
  // First Convex exports the schema (`schemaToJson` here). An error there, such as a document or staged
  // validator whose JSON is not an object, is answered with `invalid_schema_export_error`, its own message
  // dropped (STUDY-14 §6, STUDY-106).
  try {
    schemaToJson(schema);
  } catch {
    throw invalidSchemaExport();
  }
  // Then Convex parses it: a document validator a table cannot have (STUDY-14 §6).
  const document = documentTypeError(schema);
  if (document)
    throw new PushError("InvalidTopLevelTypeInSchemaError", `Hit an error while evaluating your schema:\n${document}`);
  // Then Convex's parse of the schema's JSON refuses a staged validator a table could not have
  // (`InvalidTopLevelTypeInSchemaError`, STUDY-106).
  const staged = stagedDocumentError(schema);
  if (staged)
    throw new PushError("InvalidTopLevelTypeInSchemaError", `Hit an error while evaluating your schema:\n${staged}`);
  const error = indexReferenceError(schema);
  if (error) throw new PushError("SchemaDefinitionError", `Hit an error while evaluating your schema:\n${error}`);
}

/** A module that did not load, as the push answers it (Convex's `InvalidModules`, or an export's own error). */
function loadError(e: unknown): unknown {
  if (e instanceof InvalidModulesError) return new PushError("InvalidModules", e.message);
  if (e instanceof FunctionExportError) return new PushError(e.code, e.message);
  return e;
}

/**
 * What a component's schema may not have yet (STUDY-153 PR 2b, the engine refuses it too): a staged validator (its
 * search and vector indexes are built since STUDY-157 PR 5). Refused before anything is allocated, as a 400.
 */
function checkComponentSchemas(definitions: ReadonlyMap<string, { schema: EngineSchema | null }>) {
  for (const [path, d] of definitions) {
    if (path === "" || d.schema === null) continue;
    for (const t of declaredTables(d.schema).values()) {
      const refuse = (what: string) =>
        new PushError(
          "ComponentsNotSupported",
          `Table "${t.name}" of component definition ${path}: ${what} in a component's schema are not supported yet`,
        );
      if (t.stagedDocument !== undefined) throw refuse("staged validators");
    }
  }
}

/** Whether a validator's JSON holds an infinite or NaN float literal, anywhere in it. */
function hasNonFiniteLiteral(j: unknown): boolean {
  if (typeof j !== "object" || j === null) return false;
  if (Array.isArray(j)) return j.some(hasNonFiniteLiteral);
  const o = j as Record<string, unknown>;
  if (o.type === "literal" && "value" in o) {
    const value = fromJsonValue(o.value as JSONValue);
    return typeof value === "number" && !Number.isFinite(value);
  }
  return Object.values(o).some(hasNonFiniteLiteral);
}

/**
 * Convex's `UnsupportedFloatLiteral`: a literal validator of an infinite or NaN number cannot be turned back into
 * JSON (`common/src/schemas/json.rs`, `Number::from_f64`), in a schema or a function's `args` / `returns`.
 */
function checkFloatLiterals(
  definitions: ReadonlyMap<string, { schema: EngineSchema | null; functions: Record<string, AnalyzedModule> }>,
) {
  for (const d of definitions.values()) {
    const validators = [
      ...(d.schema === null ? [] : [schemaToJson(d.schema)]),
      ...Object.values(d.functions).flatMap((m) =>
        m.functions.flatMap((f) => [JSON.parse(f.args), JSON.parse(f.returns)]),
      ),
    ];
    if (validators.some(hasNonFiniteLiteral))
      throw new PushError("UnsupportedFloatLiteral", "Infinite or NaN values are not supported in literal validators.");
  }
}

export class PushError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "PushError";
  }
}

type ModuleHash = { path: string; environment: "isolate" | "node"; sha256: string };
type StartPushRequest = {
  dryRun?: boolean;
  appDefinition?: {
    schema?: ModuleSource | null;
    changedModules?: ModuleSource[];
    unchangedModuleHashes?: ModuleHash[];
    /** The CLI's package version, as Convex's: `_udf_config.serverVersion`. */
    udfServerVersion?: string;
    /** The app's definition module (`bunvex.config.js`, DV-494), and the component definitions it imports. */
    definition?: ModuleSource | null;
    dependencies?: unknown;
  };
  /** Each component definition the app reaches (Convex's `ComponentDefinitionConfigJson`). */
  componentDefinitions?: unknown[];
  /** Convex's `forCodegen`: a dry run whose tree does not need a child's required variables. */
  forCodegen?: boolean;
  /** bunvex.json's `node.nodeVersion` (STUDY-145). */
  nodeVersion?: string | null;
  /** The packages to install for the `"use node"` modules (STUDY-148): `[{name, version}]`. */
  nodeDependencies?: unknown;
};

/**
 * The push's `nodeDependencies` (Convex's `Vec<NodeDependencyJson>`): `{name, version}` strings. Anything else is
 * the body extractor's 400 (serde's wording, abridged; the CLI never sends one).
 */
export function parseNodeDependencies(raw: unknown): NodeDependency[] {
  if (raw === undefined || (Array.isArray(raw) && raw.length === 0)) return [];
  const ok =
    Array.isArray(raw) &&
    raw.every(
      (d) =>
        typeof d === "object" &&
        d !== null &&
        typeof (d as NodeDependency).name === "string" &&
        typeof (d as NodeDependency).version === "string",
    );
  if (!ok)
    throw new PushError(
      "BadJsonBody",
      "Failed to deserialize the JSON body into the target type: nodeDependencies: invalid type, expected a sequence of {name, version} strings",
    );
  return (raw as NodeDependency[]).map(({ name, version }) => ({ name, version }));
}

/**
 * Convex's `StartPushRequest::into_project_config` (crates/application/src/deploy_config.rs) on `nodeVersion`, the
 * first thing `start_push`, `evaluate_push` and `evaluate_schema` check: Convex's `NodeVersion` takes "20", "22"
 * and "24"; "18" is refused as no longer supported; any other string is not a version. Both are 400
 * `InvalidConfig`. The version is only stored (`_source_packages.nodeVersion`): a self-hosted Convex runs its Node
 * actions on the Node it finds, and bunvex runs them in Bun (DV-87).
 */
export function parseNodeVersion(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  // Convex's body extractor refuses it before anything runs (serde's wording, abridged; the CLI never sends one).
  if (typeof raw !== "string")
    throw new PushError(
      "BadJsonBody",
      "Failed to deserialize the JSON body into the target type: nodeVersion: invalid type, expected a string",
    );
  if (raw === "20" || raw === "22" || raw === "24") return raw;
  // Convex's message ends with a link to its docs (DV-04).
  if (raw === "18")
    throw new PushError("InvalidConfig", "Node 18 is no longer supported. Upgrade to a newer Node version.");
  throw new PushError("InvalidConfig", `Invalid node version: ${raw}`);
}

type Pending = {
  version: LoadedCode;
  modules: ModuleSource[];
  authModule: ModuleSource | null;
  /** The schema's module: stored with the others, as Convex's (STUDY-134). */
  schemaModule: ModuleSource | null;
  /** The variables the push was evaluated with (Convex re-reads them at `finish_push`). */
  env: string;
  schema: EngineSchema;
  auth: unknown[] | null;
  schemaId: string;
  /** The server version change the push made (Convex's `udfConfigDiff`). */
  udfConfigDiff: UdfServerVersionDiff | null;
  /** The push's `nodeVersion`, stored with its package. */
  nodeVersion: string | null;
  /** The push's external packages, recorded with its package (STUDY-148). */
  external: PackageExternalDeps | null;
  /** The app's definition module (`bunvex.config.js`, DV-494), stored with its modules, or null. */
  definitionModule: ModuleSource | null;
  /** The app's import seed and time: every component's `_udf_config` has them too. */
  importPhase: { seed: Uint32Array; timestamp: number };
  /** Its components (STUDY-153): the tree, each definition evaluated, each namespace's schema change. */
  components: {
    /** Each component definition as pushed, by definition path. */
    configs: Map<string, ComponentDefinitionConfig>;
    tree: CheckedComponent;
    definitions: Map<string, EvaluatedDefinition & { schema: EngineSchema | null; udfServerVersion: string | null }>;
    versions: Map<string, LoadedCode>;
    change: ComponentsSchemaChange;
  };
};

const AUTH_CONFIG = AUTH_CONFIG_MODULE;
const emptySchema: EngineSchema = { tables: {}, schemaValidation: false };

export type PushDeps = {
  engine: Engine;
  modulesStore: BlobStore;
  cronExecutor: CronJobExecutor;
  /** Make a committed version live: functions, router, verifier, subscriptions. */
  install: (version: LoadedCode, auth: AuthInfo[], authModule: ModuleSource | null) => Promise<unknown>;
  /** The deployment's variables and the built-ins, as `auth.config` sees them (STUDY-37). */
  deploymentEnv: () => Promise<Record<string, string>>;
  /** The environment the external packages' install runs with (the server's own by default; STUDY-148). */
  installEnv?: Record<string, string | undefined>;
  /** How long that install may take (STUDY-174 S6): `BUILD_DEPS_TIMEOUT_MS` by default. */
  installTimeoutMs?: number;
  /** Where the push's code is loaded and evaluated (`vm` by default; STUDY-171). */
  executor?: Executor;
};

/** The variables, canonically, to tell whether they changed during a push. */
const fingerprint = (env: Record<string, string>) =>
  JSON.stringify(Object.entries(env).sort(([a], [b]) => (a < b ? -1 : 1)));

/**
 * Evaluate `auth.config.js` with the deployment's variables (Convex's `get_evaluated_auth_config`): its
 * providers. A variable it reads that is not set fails with Convex's `AuthConfigMissingEnvironmentVariable`; any
 * other failure is Convex's `InvalidAuthConfig`, "<explanation>: <error>" (crates/isolate/src/client.rs
 * `evaluate_auth_config`; "The pushed auth config is invalid" for a push, crates/application/src/lib.rs).
 */
export async function evaluateAuthConfig(
  engine: Engine,
  m: ModuleSource,
  env: Record<string, string>,
  explanation = "The pushed auth config is invalid",
  executor: Executor = vmExecutor,
): Promise<unknown[]> {
  const config = await udfConfig(engine);
  const invalid = (message: string) => new PushError("InvalidAuthConfig", `${explanation}: ${message.trimEnd()}`);
  let c: unknown;
  try {
    c = await evaluateDefaultExport(
      m,
      { seed: config.seed, timestamp: config.timestamp, env, failOnMissingEnv: true },
      "authConfig",
      executor,
    );
  } catch (e) {
    if (e instanceof MissingEnvironmentVariableError)
      throw new PushError("AuthConfigMissingEnvironmentVariable", e.message);
    throw invalid(
      e instanceof InvalidModulesError
        ? e.detail.replace(/^Failed to analyze [^:]*: /, "")
        : e instanceof UnserializableAuthConfigError
          ? e.message
          : describeUncaught(e).message,
    );
  }
  // Convex reads the config as its JSON (`v8::json::stringify`): what `JSON.stringify` refuses (a bigint, a cycle, a
  // function) is refused, and what it leaves out is not seen. The sandbox's executor already sends it so.
  if (c !== undefined && c !== null) {
    let json: string | undefined;
    try {
      json = JSON.stringify(c);
    } catch {}
    if (json === undefined) throw invalid(new UnserializableAuthConfigError().message);
    c = JSON.parse(json);
  }
  try {
    parseAuthConfig(c);
  } catch (e) {
    throw invalid((e as Error).message);
  }
  return (c as { providers: unknown[] }).providers;
}

/** A module's default export, evaluated with `config`'s seed and time; its error as a `PushError` (`code`). */
async function evaluateDefault(
  config: { seed: Uint32Array; timestamp: number },
  m: ModuleSource,
  env: Record<string, string>,
  code: string,
  what: string,
  bare = false,
  executor: Executor = vmExecutor,
) {
  try {
    const options = { seed: config.seed, timestamp: config.timestamp, env };
    return await evaluateDefaultExport(m, options, "schema", executor);
  } catch (e) {
    const message =
      e instanceof InvalidModulesError ? e.message.split("\n").slice(1).join("\n") : describeUncaught(e).message;
    if (bare) throw new PushError(code, message.replace(/^Failed to analyze [^:]*: /, ""));
    throw new PushError(code, `Hit an error while evaluating your ${what}:\n${message.trimEnd()}`);
  }
}

/**
 * Convex's `evaluate_components` and the tree's check after it: each component definition's modules analyzed
 * (the app's import seed and time, no user variables: "User env vars are root-only") and its schema evaluated;
 * the definitions evaluated from the app's (`definition-eval.ts`), or Convex's default app when the push sends
 * none; the declarations checked and the tree instantiated (`component-tree.ts`).
 */
export async function evaluateComponents(
  pushed: PushedComponents,
  config: { seed: Uint32Array; timestamp: number },
  env: Record<string, string>,
  rootFunctions: Record<string, AnalyzedModule>,
  rootSchema: EngineSchema | null,
  forCodegen: boolean,
  executor: Executor = vmExecutor,
  /** The push's own version: under `process`, each definition's code is analyzed in its child (STUDY-168 PR 7). */
  beside?: LoadedCode,
) {
  const versions = new Map<string, LoadedCode>();
  const schemas = new Map<string, EngineSchema | null>();
  for (const c of pushed.components) {
    // Convex's `ensure!`: a system error.
    if (versions.has(c.definitionPath)) throw new Error(`Component definition ${c.definitionPath} pushed twice`);
    try {
      const loaded = await loadCode(c.functions, { ...config, env: {} }, executor, beside);
      versions.set(c.definitionPath, loaded);
      // Only its analysis is kept (the instances run the code their namespaces store, loaded at the install).
      executor.release?.(loaded);
    } catch (e) {
      throw loadError(e);
    }
    let schema: EngineSchema | null = null;
    if (c.schema) {
      schema = schemaExport(await evaluateDefault(config, c.schema, {}, "InvalidSchema", "schema", true, executor));
      checkIndexReferences(schema);
    }
    schemas.set(c.definitionPath, schema);
  }
  let evaluated: Map<string, NewComponentDefinition>;
  if (pushed.definition) {
    try {
      evaluated = await evaluateDefinitions({
        app: { definition: pushed.definition, dependencies: pushed.dependencies },
        components: new Map(
          pushed.components.map((c) => [c.definitionPath, { definition: c.definition, dependencies: c.dependencies }]),
        ),
        env,
      });
    } catch (e) {
      if (e instanceof DefinitionError) throw new PushError(e.code, e.message);
      throw e;
    }
  } else evaluated = new Map([["", DEFAULT_ROOT]]);
  const udfServerVersions = new Map(pushed.components.map((c) => [c.definitionPath, c.udfServerVersion]));
  const definitions = new Map(
    [...evaluated].map(([path, definition]) => [
      path,
      {
        definition,
        schema: path === "" ? rootSchema : (schemas.get(path) ?? null),
        functions: path === "" ? rootFunctions : versions.get(path)!.analysis,
        udfServerVersion: path === "" ? null : (udfServerVersions.get(path) ?? null),
      },
    ]),
  );
  let tree: CheckedComponent;
  try {
    checkEnvVarDeclarations(definitions);
    tree = instantiateRoot(definitions, { validateEnvVars: !forCodegen });
  } catch (e) {
    if (e instanceof ComponentTreeError) throw new PushError(e.code, e.message);
    throw e;
  }
  return { tree, definitions, versions };
}

export class PushService {
  private pending = new Map<string, Pending>();
  constructor(private deps: PushDeps) {}

  private get executor(): Executor {
    return this.deps.executor ?? vmExecutor;
  }

  /**
   * Convex's `get_config_hashes`: what is deployed, by path. None when the package cannot be read (STUDY-139
   * P4): the client then sends every module, and the push replaces it.
   */
  async configHashes() {
    const stored = await storedModules(this.deps.engine);
    const readable = stored !== null && (await readablePackage(this.deps.modulesStore, stored.pkg.storageKey)) !== null;
    return {
      config: { functions: "", authInfo: [] },
      moduleHashes: (readable ? stored.rows : []).map((r) => ({
        path: r.path,
        hash: r.sha256,
        environment: r.environment,
      })),
      // As Convex's: the latest package's, whether or not it can be read.
      nodeVersion: stored?.pkg.nodeVersion ?? null,
    };
  }

  /** The push's modules: the changed ones sent, and the unchanged ones taken from the deployed package. */
  private async resolveModules(req: StartPushRequest): Promise<ModuleSource[]> {
    const changed = req.appDefinition?.changedModules ?? [];
    const unchanged = req.appDefinition?.unchangedModuleHashes ?? [];
    if (!unchanged.length) return changed;
    const stored = await storedModules(this.deps.engine);
    const sources = (stored && (await readablePackage(this.deps.modulesStore, stored.pkg.storageKey))) ?? [];
    const rows = new Map((stored?.rows ?? []).map((r) => [r.path, r]));
    const byPath = new Map(sources.map((m) => [m.path, m]));
    const out = [...changed];
    for (const h of unchanged) {
      const row = rows.get(h.path);
      const source = byPath.get(h.path);
      if (!row || !source)
        throw new PushError("MissingExistingModule", `Module ${h.path} was marked unchanged but is not deployed`, 409);
      if (row.sha256 !== h.sha256)
        throw new PushError("ExistingModuleHashConflict", `Module ${h.path} does not have the hash ${h.sha256}`, 409);
      if (row.environment !== h.environment)
        throw new PushError(
          "ExistingModuleEnvConflict",
          `Module ${h.path} runs in ${row.environment}, not ${h.environment}`,
          409,
        );
      out.push(source);
    }
    return out;
  }

  /** Evaluate one standalone module (the schema, auth.config) and return its default export. */
  private async evaluateDefault(
    m: ModuleSource,
    env: Record<string, string>,
    code: string,
    what: string,
    /** A component's schema: Convex answers its exception alone (`evaluate_components`), with no preamble. */
    bare = false,
  ) {
    return evaluateDefault(await udfConfig(this.deps.engine), m, env, code, what, bare, this.executor);
  }

  /**
   * Convex's `evaluate_schema` (STUDY-56): the push's schema only (no function module is analyzed), and what
   * pushing it would do to the indexes and the tables — the CLI's large-index and slow-validation checks.
   */
  async evaluateSchema(req: StartPushRequest) {
    parseNodeVersion(req.nodeVersion);
    let pushed: PushedComponents;
    try {
      pushed = parsePushedComponents(req.appDefinition, req.componentDefinitions);
    } catch (e) {
      if (e instanceof InvalidConfigError) throw new PushError(e.code, e.message);
      throw e;
    }
    // Each pushed definition's schema, by definition path (null: pushed without one), as Convex's `pushed_schemas`.
    const pushedSchemas = new Map<string, EngineSchema | null>();
    const schemaModule = req.appDefinition?.schema;
    let rootSchema: EngineSchema | null = null;
    if (schemaModule) {
      rootSchema = schemaExport(await this.evaluateDefault(schemaModule, {}, "InvalidSchema", "schema"));
      checkIndexReferences(rootSchema);
    }
    pushedSchemas.set("", rootSchema);
    for (const c of pushed.components) {
      let schema: EngineSchema | null = null;
      if (c.schema) {
        schema = schemaExport(await this.evaluateDefault(c.schema, {}, "InvalidSchema", "schema", true));
        checkIndexReferences(schema);
      }
      pushedSchemas.set(c.definitionPath, schema);
    }
    // Every instance (Convex's `evaluate_schema_prediction`): the app's, there even with no `_components` row, and each
    // other component by path; an unmounted one whose definition is gone has nothing to predict.
    const instances = await this.deps.engine.query((db) =>
      db.asSystem(async () => {
        const definitionPaths = new Map(
          (await db.query("_component_definitions").collect()).map((d) => [d._id as string, d.path as string]),
        );
        const out: { id: string | null; path: string; definitionPath: string }[] = [
          { id: null, path: "", definitionPath: "" },
        ];
        for (const row of await db.query("_components").collect()) {
          const c = componentMeta(row as Record<string, unknown>);
          if (c.parent === null) continue;
          const path = await componentPath(db, c._id);
          if (path === null) continue;
          const definitionPath = definitionPaths.get(c.definitionId);
          if (definitionPath === undefined) {
            if (c.state === "unmounted") continue;
            // Convex's `bail!`: a system error.
            throw new Error(`component ${path.join("/")} references an unknown definition`);
          }
          out.push({ id: c._id, path: path.join("/"), definitionPath });
        }
        return out;
      }),
    );
    const evaluations: [string, unknown][] = [];
    for (const i of instances) {
      // A definition the push does not carry keeps its schema, tables and indexes: nothing predicted.
      if (!pushedSchemas.has(i.definitionPath)) {
        evaluations.push([
          i.path,
          {
            definitionPath: i.definitionPath,
            schemaValidation: false,
            tables: [],
            indexes: [],
            discardedStagedValidators: [],
          },
        ]);
        continue;
      }
      const schema = pushedSchemas.get(i.definitionPath) ?? null;
      // Pushed without a schema: every index dropped, no table checked.
      const p = await this.deps.engine.evaluateSchema(schema ?? emptySchema, i.id);
      evaluations.push([
        i.path,
        {
          definitionPath: i.definitionPath,
          schemaValidation: schema ? p.schemaValidation : false,
          tables: schema ? p.tables : [],
          indexes: p.indexes,
          discardedStagedValidators: p.discardedStagedValidators,
        },
      ]);
    }
    const instantiated = new Set(instances.map((i) => i.definitionPath));
    return {
      componentSchemaEvaluations: Object.fromEntries(evaluations.sort(([a], [b]) => byPath(a, b))),
      // Pushed definitions with no instance yet: a fresh namespace, nothing walked.
      newComponentDefinitions: [...pushedSchemas.keys()].filter((p) => !instantiated.has(p)).sort(byPath),
    };
  }

  /**
   * Convex's `build_external_node_deps` (STUDY-148): the newest matching `_external_deps_packages` row, else an
   * install, recorded; the packages ready in this process either way. A failed install is a 400
   * `InvalidExternalModules`.
   */
  private async externalDeps(deps: NodeDependency[]): Promise<{ row: ExternalDepsPackage; dir: string }> {
    let row = await cachedExternalDeps(this.deps.engine, deps);
    try {
      row ??= await buildExternalDeps(this.deps.engine, this.deps.modulesStore, deps, this.deps.installEnv, {
        timeoutMs: this.deps.installTimeoutMs,
      });
    } catch (e) {
      if (e instanceof ExternalDepsError)
        throw new PushError(e.code, `Loading the pushed modules encountered the following error:\n${e.message}`);
      throw e;
    }
    return { row, dir: await externalDepsPath(this.deps.modulesStore, row) };
  }

  async startPush(req: StartPushRequest) {
    const nodeVersion = parseNodeVersion(req.nodeVersion);
    const nodeDependencies = parseNodeDependencies(req.nodeDependencies);
    let pushed: PushedComponents;
    try {
      pushed = parsePushedComponents(req.appDefinition, req.componentDefinitions);
    } catch (e) {
      if (e instanceof InvalidConfigError) throw new PushError(e.code, e.message);
      throw e;
    }
    // Convex's `upload_packages` installs them first, on a dry run too.
    const installed = nodeDependencies.length ? await this.externalDeps(nodeDependencies) : null;
    const external: PackageExternalDeps | null = installed && {
      id: installed.row._id,
      storageKey: installed.row.storageKey,
      zipped: Number(installed.row.packageSize.zippedSizeBytes),
      unzipped: Number(installed.row.packageSize.unzippedSizeBytes),
    };
    const all = await this.resolveModules(req);
    // Convex's `start_push` uploads and size-checks the packages first (`upload_packages`, `verify_size`): the app's
    // (its modules, schema and definition) and one per component definition, the external packages counted in, ONE
    // check over the total.
    const present = (...ms: (ModuleSource | null | undefined)[]) => ms.filter((m): m is ModuleSource => !!m);
    try {
      checkPackagesSize(
        [
          [...all, ...present(req.appDefinition?.schema, pushed.definition)],
          ...pushed.components.map((c) => [...c.functions, ...present(c.schema, c.definition)]),
        ],
        external,
      );
    } catch (e) {
      if (e instanceof ModulesTooLargeError) throw new PushError(e.code, e.message);
      throw e;
    }
    const authModule = all.find((m) => m.path === AUTH_CONFIG);
    const modules = all.filter((m) => m.path !== AUTH_CONFIG);
    const config = await udfConfig(this.deps.engine, req.appDefinition?.udfServerVersion);
    // The deployment's variables: what the modules read at import, as Convex's analysis gives them its
    // environment variables (the version this push installs keeps them, as one loaded at a start does).
    const env = await this.deps.deploymentEnv();
    let version: LoadedCode;
    try {
      version = await loadCode(
        modules,
        {
          seed: config.seed,
          timestamp: config.timestamp,
          env,
          ...(installed ? { nodeModules: installed.dir } : {}),
        },
        this.executor,
      );
    } catch (e) {
      throw loadError(e);
    }
    let schema = emptySchema;
    const schemaModule = req.appDefinition?.schema;
    if (schemaModule) {
      const s = schemaExport(await this.evaluateDefault(schemaModule, {}, "InvalidSchema", "schema"));
      checkIndexReferences(s);
      schema = s;
    }
    const auth = authModule
      ? await evaluateAuthConfig(this.deps.engine, authModule, env, undefined, this.executor)
      : null;
    const components = await evaluateComponents(
      pushed,
      config,
      env,
      version.analysis,
      schemaModule ? schema : null,
      req.forCodegen === true,
      this.executor,
      version,
    );
    checkFloatLiterals(components.definitions);
    // Convex's `StagedSchemaWithEnforcedValidatorChanges` (STUDY-106 §7.4), dry run too.
    const staged = await this.deps.engine.stagedValidatorConflicts(schema);
    if (staged) throw new PushError(staged.code, staged.message);
    const externalDepsId = external?.id ?? null;
    // A dry run (and Convex's `forCodegen`) writes nothing (DV-444): what the push would do to each namespace's
    // indexes, against its active schema.
    const dryRun = req.dryRun === true || req.forCodegen === true;
    const schemas = new Map([...components.definitions].map(([path, d]) => [path, d.schema]));
    if (!dryRun) checkComponentSchemas(components.definitions);
    let change: Awaited<ReturnType<typeof startComponentSchemas>>;
    let schemaId: string;
    try {
      change = await startComponentSchemas(this.deps.engine, components.tree, schemas, schema, dryRun);
      if (dryRun) return this.response(auth, components, change, externalDepsId);
      ({ rootSchemaId: schemaId } = await change.start());
    } catch (e) {
      // Convex's `TooManyTables`, a 400 with its message, when the schema adds tables past the cap.
      if (e instanceof TooManyTablesError) throw new PushError(e.code, e.message);
      throw e;
    }
    this.pending.set(schemaId, {
      version,
      modules,
      authModule: authModule ?? null,
      schemaModule: req.appDefinition?.schema ?? null,
      env: fingerprint(env),
      schema,
      auth,
      schemaId,
      udfConfigDiff: config.diff,
      nodeVersion,
      external,
      definitionModule: pushed.definition ? definitionModule(pushed.definition) : null,
      importPhase: { seed: config.seed, timestamp: config.timestamp },
      components: { ...components, change, configs: new Map(pushed.components.map((c) => [c.definitionPath, c])) },
    });
    return this.response(auth, components, change, externalDepsId);
  }

  private response(
    auth: unknown[] | null,
    components: { tree: CheckedComponent; definitions: Pending["components"]["definitions"] },
    change: ComponentsSchemaChange,
    externalDepsId: string | null,
  ) {
    return {
      environmentVariables: {},
      externalDepsId,
      componentDefinitionPackages: {},
      appAuth: auth ?? [],
      analysis: analysisAnswer(components.definitions),
      app: serializedCheckedComponent(components.tree),
      schemaChange: schemaChangeAnswer(change),
    };
  }

  /**
   * Convex's `wait_for_schema`: until no component's schema change is in progress, or `timeoutMs`. Each pushed
   * schema is read in its component's namespace (an existing component's, else the one the push allocated); one
   * failed is the push's failure, naming its component; one overwritten, a race.
   */
  async waitForSchema(req: {
    schemaChange?: { schemaIds?: Record<string, string | null>; allocatedComponentIds?: Record<string, string> };
    timeoutMs?: number;
  }) {
    const schemaIds = Object.entries(req.schemaChange?.schemaIds ?? {}).filter(
      (e): e is [string, string] => typeof e[1] === "string",
    );
    const allocated = req.schemaChange?.allocatedComponentIds ?? {};
    const deadline = Date.now() + Math.min(req.timeoutMs ?? 10_000, 60_000);
    for (;;) {
      const components: Record<
        string,
        { schemaValidationComplete: boolean; indexesComplete: number; indexesTotal: number }
      > = {};
      let complete = true;
      for (const [path, schemaId] of schemaIds) {
        const s = await this.deps.engine.schemaPushStatus(schemaId, await this.namespaceOf(path, allocated[path]));
        if (s.type === "failed") return { type: "failed", error: s.error, componentPath: path, tableName: s.tableName };
        if (s.type === "raceDetected") return { type: "raceDetected" };
        if (s.type === "inProgress") {
          complete = false;
          components[path] = {
            schemaValidationComplete: s.schemaValidationComplete,
            indexesComplete: s.indexesComplete,
            indexesTotal: s.indexesTotal,
          };
        } else
          components[path] = {
            schemaValidationComplete: true,
            indexesComplete: s.indexesTotal,
            indexesTotal: s.indexesTotal,
          };
      }
      if (complete) return { type: "complete" };
      if (Date.now() >= deadline) return { type: "inProgress", components };
      await Bun.sleep(100);
    }
  }

  /**
   * The namespace of the component at `path` (Convex's `load_component_schema_status`, d8bdde0): the app's (null), an
   * existing component's, or the one the push allocated. A component a concurrent push created under another id is a
   * 409 `RaceDetected` (the CLI pushes again); neither is no state a push leaves (a system error, as Convex's).
   */
  private async namespaceOf(path: string, allocated: string | undefined): Promise<string | null> {
    if (path === "") return null;
    const existing = await this.deps.engine.query((db) => resolveComponentPath(db, path.split("/")));
    if (existing && (allocated === undefined || allocated === existing._id)) return existing._id;
    if (existing) throw new PushError("RaceDetected", `Component ${path} was created by a concurrent push`, 409);
    if (allocated !== undefined) return allocated;
    throw new Error(`Invalid existing component state for ${path}`);
  }

  /**
   * Convex's `finish_push`: ONE commit makes everything live. The app's required variables checked; then the
   * definitions and the components tree (`finishComponents`), each instance's code, server version, crons and schema;
   * the auth; the audit event with every component's diff. The app's version goes live; a component's code is stored,
   * and runs from STUDY-152 step 4.
   */
  async finishPush(
    req: { startPush?: { schemaChange?: { schemaIds?: Record<string, string> } }; dryRun?: boolean; message?: unknown },
    actor: AuditLogActor = SYSTEM_ACTOR,
  ) {
    // Convex's `PushMessage`: at most 1024 bytes.
    const message = typeof req.message === "string" ? req.message : null;
    if (message !== null && new TextEncoder().encode(message).length > 1024)
      throw new PushError("PushMessageTooLong", "Push messages can be at most 1024 bytes long");
    const schemaId = req.startPush?.schemaChange?.schemaIds?.[""];
    const p = schemaId ? this.pending.get(schemaId) : undefined;
    if (!p) throw new PushError("RaceDetected", "Schema was overwritten by another push.");
    const engine = this.deps.engine;
    if (req.dryRun) return this.diff(new Map(), new Map([["", this.rootDryRunDiff(p)]]), { added: [], removed: [] });
    // As Convex: the push was evaluated with variables that must still be the deployment's.
    if (fingerprint(await this.deps.deploymentEnv()) !== p.env)
      throw new PushError("RaceDetected", "Environment variables have changed during push");
    const { tree, change, definitions } = p.components;
    const stored = await storedModules(engine);
    // Each instance's index and schema change, against its active schema, read before the commit replaces them.
    const indexDiffs = new Map<string, ComponentDiff["indexDiff"]>();
    const schemaDiffs = new Map<string, ComponentDiff["schemaDiff"]>();
    const componentSchemaIds = new Map<string, string>();
    for (const [key, ns] of change.namespaces) {
      const node = componentsOf(tree).get(key)!;
      const next = key === "" ? p.schema : (definitions.get(node.definitionPath)?.schema ?? null);
      const before = ns === null ? engine.schema : engine.componentSchema(ns);
      indexDiffs.set(key, indexAuditDiff(before, next ?? emptySchema));
      const id = change.schemaIds.get(key) ?? null;
      if (ns !== null && id !== null) componentSchemaIds.set(ns, id);
      const rows = (await engine.query((db) =>
        db.asSystem(() => db.inComponent(ns, () => db.query(SCHEMAS_TABLE).collect())),
      )) as unknown as ({ _id: string; schema: string } & Record<string, unknown>)[];
      const previous = rows.find((r) => schemaStateOf(r) === "active")?.schema ?? null;
      const following = id === null ? null : (rows.find((r) => r._id === id)?.schema ?? null);
      schemaDiffs.set(key, previous === following ? null : { previous_schema: previous, next_schema: following });
    }
    // The providers the push stores in `_auth` (none without an auth.config, as Convex's `app_auth`).
    const auth = p.auth === null ? [] : parseAuthConfig({ providers: p.auth } as never);
    // Convex's `node_version_diff`: the latest package's version before and after, when they differ.
    const previousNodeVersion = stored?.pkg.nodeVersion ?? null;
    const nodeVersionDiff =
      previousNodeVersion === p.nodeVersion
        ? null
        : { previous_version: previousNodeVersion, next_version: p.nodeVersion };
    // One package per definition (two instances of one share it, as Convex's), the app's first. As Convex's, the
    // schema, the auth config and the definition module are modules of the push too (they define no function).
    const written: SourcePackageFields[] = [];
    const code = new Map<string, DefinitionCode>();
    try {
      const rootOther = [p.authModule, p.schemaModule, p.definitionModule].filter((m): m is ModuleSource => m !== null);
      const rootPkg = await writePackage(
        this.deps.modulesStore,
        [...p.modules, ...rootOther],
        undefined,
        p.nodeVersion,
        p.external,
      );
      written.push(rootPkg);
      code.set("", { pkg: rootPkg, version: p.version, other: rootOther });
      for (const [path, version] of p.components.versions) {
        if (!definitions.has(path)) continue;
        const c = p.components.configs.get(path)!;
        const other = [definitionModule(c.definition), ...(c.schema ? [c.schema] : [])];
        const pkg = await writePackage(this.deps.modulesStore, [...c.functions, ...other]);
        written.push(pkg);
        code.set(path, { pkg, version, other });
      }
    } catch (e) {
      for (const w of written) await this.deps.modulesStore.delete(w.storageKey).catch(() => {});
      throw e instanceof ModulesTooLargeError ? new PushError(e.code, e.message, 400) : e;
    }
    const rootSpecs = new Map(Object.entries(p.version.analysis["crons.js"]?.cronSpecs ?? {}));
    let committed: { value: Awaited<ReturnType<typeof finishComponents>> & { authDiff: ComponentDiff["moduleDiff"] } };
    try {
      committed = (await engine.commitSchemaPush(
        p.schemaId,
        async (db) => {
          checkAppEnv(definitions.get("")!.definition, await engine.environment.snapshot(db));
          // Convex's `AuthInfoModel::put`, in the push's commit: its diff is the push's `authDiff`.
          const authDiff = await putAuthInfo(db, auth);
          const finished = await finishComponents(db, {
            definitions,
            tree,
            change,
            code,
            importPhase: p.importPhase,
            rootUdfConfigDiff: p.udfConfigDiff,
            indexDiffs: new Map([...indexDiffs].map(([k, d]) => [k, indexDiffJson(d)])),
            schemaDiffs,
            componentsTable: engine.catalog.table("_components")!,
            // Analysis checked the targets (Convex's `validate_cron_jobs`) and kept the specs.
            crons: async (tx, ns, version) => {
              const specs = new Map(Object.entries(version?.analysis["crons.js"]?.cronSpecs ?? {}));
              return (
                ns === null
                  ? await this.deps.cronExecutor.applyIn(tx, rootSpecs)
                  : await this.deps.cronExecutor.applyInComponent(tx, ns, specs)
              ) as CronDiff;
            },
          });
          // Convex's `push_config_with_components`, in the push's commit: the app's diff first, then by path.
          await insertAuditLogEvents(
            db,
            [
              auditEvents.pushConfigWithComponents({
                authDiff,
                componentDiffs: [...finished.componentDiffs]
                  .sort(([a], [b]) => byPath(a, b))
                  .map(([path, diff]) => ({ path: path === "" ? null : path, diff })),
                message,
                nodeVersionDiff,
              }),
            ],
            actor,
          );
          return { ...finished, authDiff };
        },
        componentSchemaIds,
      )) as typeof committed;
    } catch (e) {
      for (const w of written) await this.deps.modulesStore.delete(w.storageKey).catch(() => {});
      if (e instanceof RaceError) throw new PushError(e.code, e.message, 409);
      if (e instanceof SchemaPushError)
        throw new PushError(
          e.code,
          e.code === "RaceDetected" ? e.message : `Hit an error while pushing:\n${e.message}`,
        );
      throw e;
    }
    this.pending.delete(p.schemaId);
    for (const id of this.pending.keys()) if (id !== p.schemaId) this.pending.delete(id);
    await this.deps.install(p.version, auth, p.authModule);
    this.deps.cronExecutor.refresh();
    // A blob is deleted once no namespace's `_source_packages` row names it (two instances share one).
    const unused = committed.value.unused;
    if (unused.length) {
      const namespaces = [null, ...engine.catalog.components.keys()];
      const kept = await engine.query((db) => referencedPackageKeys(db, namespaces));
      for (const old of unused)
        if (!kept.has(old.storageKey)) await this.deps.modulesStore.delete(old.storageKey).catch(() => {});
    }
    return this.diff(committed.value.definitionDiffs, committed.value.componentDiffs, committed.value.authDiff);
  }

  /** A dry run's finish (Convex answers a diff without committing): the app's index change only. */
  private rootDryRunDiff(p: Pending): ComponentDiff {
    return {
      diffType: { type: "modify" },
      moduleDiff: { added: [], removed: [] },
      udfConfigDiff: null,
      cronDiff: emptyCronDiff(),
      indexDiff: indexDiffJson(indexAuditDiff(this.deps.engine.schema, p.schema)),
      schemaDiff: null,
    };
  }

  /** `finish_push`'s answer (Convex's `SerializedFinishPushDiff`): every map by path. */
  private diff(
    definitionDiffs: Map<string, Record<string, never>>,
    componentDiffs: Map<string, ComponentDiff>,
    authDiff: { added: string[]; removed: string[] },
  ) {
    const sorted = <T>(m: Map<string, T>) => Object.fromEntries([...m].sort(([a], [b]) => byPath(a, b)));
    return { authDiff, definitionDiffs: sorted(definitionDiffs), componentDiffs: sorted(componentDiffs) };
  }
}

/**
 * Convex's checks of the app's declared variables at `finish_push`: each required one set
 * (`MissingEnvironmentVariables`, in bunvex's words, DV-494), each set one matching its validator
 * (`InvalidEnvironmentVariable`).
 */
function checkAppEnv(app: NewComponentDefinition, vars: Map<string, string>) {
  const missing = app.envVars.filter(([name, v]) => !v.optional && !vars.has(name)).map(([name]) => name);
  if (missing.length)
    throw new PushError(
      "MissingEnvironmentVariables",
      `Required environment variables are not set: ${missing.join(", ")}. Set them in the dashboard or CLI before pushing.`,
    );
  const declared = new Map(app.envVars);
  for (const [name, value] of [...vars].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const v = declared.get(name);
    if (!v) continue;
    const problem = checkValue(validatorFromJson(JSON.parse(v.value)), value);
    if (problem !== null)
      throw new PushError(
        "InvalidEnvironmentVariable",
        `Environment variable ${name} does not match its declared validator: ${problem}`,
      );
  }
}

type CronDiff = { added: string[]; updated: string[]; deleted: string[] };
const emptyCronDiff = (): CronDiff => ({ added: [], updated: [], deleted: [] });

/**
 * What `start_push` answers as `analysis` for a push's definitions, without a deployment (STUDY-156 Q-1, DV-532):
 * the CLI's codegen reads each definition's children, exports and validators from it, as Convex's reads its
 * `forCodegen` push. The app's own functions are left out (its `api` is typed from its code).
 */
export async function componentAnalysis(
  appDefinition: { definition?: ModuleSource | null; dependencies?: unknown },
  componentDefinitions: unknown,
) {
  const pushed = parsePushedComponents(appDefinition, componentDefinitions);
  const config = { seed: crypto.getRandomValues(new Uint32Array(8)), timestamp: Date.now() };
  const { definitions } = await evaluateComponents(pushed, config, {}, {}, null, true);
  return analysisAnswer(definitions);
}
