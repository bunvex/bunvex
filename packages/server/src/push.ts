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
  indexReferenceError,
  insertAuditLogEvents,
  type NewComponentDefinition,
  resolveComponentPath,
  SCHEMAS_TABLE,
  type SchemaDefinition,
  SchemaPushError,
  SYSTEM_ACTOR,
  schemaStateOf,
  schemaToJson,
  stagedDocumentError,
  TooManyTablesError,
} from "@bunvex/core";
import type { BlobStore } from "@bunvex/file-storage";
import { auditEvents } from "./audit-log.ts";
import { putAuthInfo } from "./auth-info.ts";
import {
  AUTH_CONFIG_MODULE,
  checkPackagesSize,
  ModulesTooLargeError,
  type PackageExternalDeps,
  readablePackage,
  type SourcePackage,
  storedModules,
  type UdfServerVersionDiff,
  udfConfig,
  writeCodeRows,
  writePackage,
} from "./code-store.ts";
import {
  type AnalyzedModule,
  CodeVersion,
  FunctionExportError,
  InvalidModulesError,
  type ModuleSource,
} from "./code-version.ts";
import {
  type CheckedComponent,
  ComponentTreeError,
  checkEnvVarDeclarations,
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
import { indexAuditDiff, indexDiffJson } from "./push-audit.ts";
import {
  analysisAnswer,
  byPath,
  type ComponentsSchemaChange,
  DEFAULT_ROOT,
  InvalidConfigError,
  type PushedComponents,
  parsePushedComponents,
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
/** A schema module's default export as `defineSchema` makes it: its tables a record of table definitions. */
function isSchema(value: unknown): value is SchemaDefinition {
  const tables = (value as SchemaDefinition | null)?.tables;
  return (
    typeof tables === "object" &&
    tables !== null &&
    !(tables instanceof Map) &&
    typeof (value as SchemaDefinition).schemaValidation === "boolean"
  );
}

function schemaExport(value: unknown): SchemaDefinition {
  if (value === undefined || value === null)
    throw new PushError(
      "MissingSchemaExportError",
      "Hit an error while evaluating your schema:\nSchema file missing default export.",
    );
  if (!isSchema(value)) throw invalidSchemaExport();
  return value as SchemaDefinition;
}

function checkIndexReferences(schema: SchemaDefinition) {
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
 * What a component's schema may not have yet (STUDY-153 PR 2b, the engine refuses it too): a staged validator, a
 * search or vector index. Refused before anything is allocated, as a 400.
 */
function checkComponentSchemas(definitions: ReadonlyMap<string, { schema: SchemaDefinition | null }>) {
  for (const [path, d] of definitions) {
    if (path === "" || d.schema === null) continue;
    for (const t of declaredTables(d.schema).values()) {
      const refuse = (what: string) =>
        new PushError(
          "ComponentsNotSupported",
          `Table "${t.name}" of component definition ${path}: ${what} in a component's schema are not supported yet`,
        );
      if (t.stagedDocument !== undefined) throw refuse("staged validators");
      if (Object.keys(t.searchIndexes ?? {}).length + Object.keys(t.vectorIndexes ?? {}).length > 0)
        throw refuse("search and vector indexes");
    }
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
  version: CodeVersion;
  modules: ModuleSource[];
  authModule: ModuleSource | null;
  /** The schema's module: stored with the others, as Convex's (STUDY-134). */
  schemaModule: ModuleSource | null;
  /** The variables the push was evaluated with (Convex re-reads them at `finish_push`). */
  env: string;
  schema: SchemaDefinition;
  auth: unknown[] | null;
  schemaId: string;
  /** The server version change the push made (Convex's `udfConfigDiff`). */
  udfConfigDiff: UdfServerVersionDiff | null;
  /** The push's `nodeVersion`, stored with its package. */
  nodeVersion: string | null;
  /** The push's external packages, recorded with its package (STUDY-148). */
  external: PackageExternalDeps | null;
  /** Its components (STUDY-153): the tree, each definition evaluated, each namespace's schema change. */
  components: {
    tree: CheckedComponent;
    definitions: Map<
      string,
      EvaluatedDefinition & { schema: SchemaDefinition | null; udfServerVersion: string | null }
    >;
    versions: Map<string, CodeVersion>;
    change: ComponentsSchemaChange;
  };
};

const AUTH_CONFIG = AUTH_CONFIG_MODULE;
const emptySchema: SchemaDefinition = { tables: {}, schemaValidation: false };

export type PushDeps = {
  engine: Engine;
  modulesStore: BlobStore;
  cronExecutor: CronJobExecutor;
  /** Make a committed version live: functions, router, verifier, subscriptions. */
  install: (version: CodeVersion, auth: AuthInfo[], authModule: ModuleSource | null) => Promise<unknown>;
  /** The deployment's variables and the built-ins, as `auth.config` sees them (STUDY-37). */
  deploymentEnv: () => Promise<Record<string, string>>;
  /** The environment the external packages' install runs with (the server's own by default; STUDY-148). */
  installEnv?: Record<string, string | undefined>;
};

/** The variables, canonically, to tell whether they changed during a push. */
const fingerprint = (env: Record<string, string>) =>
  JSON.stringify(Object.entries(env).sort(([a], [b]) => (a < b ? -1 : 1)));

/**
 * Evaluate `auth.config.js` with the deployment's variables (Convex's `get_evaluated_auth_config`): its
 * providers. A variable it reads that is not set fails with Convex's `AuthConfigMissingEnvironmentVariable`.
 */
export async function evaluateAuthConfig(
  engine: Engine,
  m: ModuleSource,
  env: Record<string, string>,
  explanation = "Hit an error while evaluating your auth config",
): Promise<unknown[]> {
  const config = await udfConfig(engine);
  let missing: string | null = null;
  let c: unknown;
  try {
    const v = await CodeVersion.load([m], {
      seed: config.seed,
      timestamp: config.timestamp,
      env,
      onMissingEnv: (name) => {
        missing = name;
        throw new Error(`Environment variable ${name} is used in auth config file but its value was not set`);
      },
    });
    c = (v.modules.get(m.path)!.module.namespace as { default?: unknown }).default;
  } catch (e) {
    if (missing !== null)
      throw new PushError(
        "AuthConfigMissingEnvironmentVariable",
        `Environment variable ${missing} is used in auth config file but its value was not set`,
      );
    const message =
      e instanceof InvalidModulesError ? e.message.split("\n").slice(1).join("\n") : describeUncaught(e).message;
    throw new PushError("InvalidAuthConfig", `${explanation}:\n${message.trimEnd()}`);
  }
  try {
    parseAuthConfig(c);
  } catch (e) {
    throw new PushError("InvalidAuthConfig", (e as Error).message);
  }
  return (c as { providers: unknown[] }).providers;
}

export class PushService {
  private pending = new Map<string, Pending>();
  constructor(private deps: PushDeps) {}

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
    const config = await udfConfig(this.deps.engine);
    try {
      const v = await CodeVersion.load([{ ...m, path: m.path }], {
        seed: config.seed,
        timestamp: config.timestamp,
        env,
      });
      return (v.modules.get(m.path)!.module.namespace as { default?: unknown }).default;
    } catch (e) {
      const message =
        e instanceof InvalidModulesError ? e.message.split("\n").slice(1).join("\n") : describeUncaught(e).message;
      if (bare) throw new PushError(code, message.replace(/^Failed to analyze [^:]*: /, ""));
      throw new PushError(code, `Hit an error while evaluating your ${what}:\n${message.trimEnd()}`);
    }
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
    const pushedSchemas = new Map<string, SchemaDefinition | null>();
    const schemaModule = req.appDefinition?.schema;
    let rootSchema: SchemaDefinition | null = null;
    if (schemaModule) {
      rootSchema = schemaExport(await this.evaluateDefault(schemaModule, {}, "InvalidSchema", "schema"));
      checkIndexReferences(rootSchema);
    }
    pushedSchemas.set("", rootSchema);
    for (const c of pushed.components) {
      let schema: SchemaDefinition | null = null;
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
      row ??= await buildExternalDeps(this.deps.engine, this.deps.modulesStore, deps, this.deps.installEnv);
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
    let version: CodeVersion;
    try {
      version = await CodeVersion.load(modules, {
        seed: config.seed,
        timestamp: config.timestamp,
        env,
        ...(installed ? { nodeModules: installed.dir } : {}),
      });
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
    const auth = authModule ? await evaluateAuthConfig(this.deps.engine, authModule, env) : null;
    const components = await this.evaluateComponents(
      pushed,
      config,
      env,
      version.analysis,
      schemaModule ? schema : null,
      req.forCodegen === true,
    );
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
      components: { ...components, change },
    });
    return this.response(auth, components, change, externalDepsId);
  }

  /**
   * Convex's `evaluate_components` and the tree's check after it: each component definition's modules analyzed
   * (the app's import seed and time, no user variables: "User env vars are root-only") and its schema evaluated;
   * the definitions evaluated from the app's (`definition-eval.ts`), or Convex's default app when the push sends
   * none; the declarations checked and the tree instantiated (`component-tree.ts`).
   */
  private async evaluateComponents(
    pushed: PushedComponents,
    config: { seed: Uint32Array; timestamp: number },
    env: Record<string, string>,
    rootFunctions: Record<string, AnalyzedModule>,
    rootSchema: SchemaDefinition | null,
    forCodegen: boolean,
  ) {
    const versions = new Map<string, CodeVersion>();
    const schemas = new Map<string, SchemaDefinition | null>();
    for (const c of pushed.components) {
      // Convex's `ensure!`: a system error.
      if (versions.has(c.definitionPath)) throw new Error(`Component definition ${c.definitionPath} pushed twice`);
      try {
        versions.set(c.definitionPath, await CodeVersion.load(c.functions, { ...config, env: {} }));
      } catch (e) {
        throw loadError(e);
      }
      let schema: SchemaDefinition | null = null;
      if (c.schema) {
        schema = schemaExport(await this.evaluateDefault(c.schema, {}, "InvalidSchema", "schema", true));
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
            pushed.components.map((c) => [
              c.definitionPath,
              { definition: c.definition, dependencies: c.dependencies },
            ]),
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

  /** Convex's `finish_push`: one commit makes everything live. */
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
    // A push with components finishes from STUDY-153 PR 4 on; its start allocated their namespaces and started their
    // schemas, which stay as an abandoned start leaves them (Convex's too, C-10).
    if (p.components.tree.childComponents.size > 0)
      throw new PushError("ComponentsNotSupported", "Components are not supported by this deployment yet");
    if (req.dryRun)
      return this.diff([], indexDiffJson(indexAuditDiff(this.deps.engine.schema, p.schema)), emptyCronDiff());
    // As Convex: the push was evaluated with variables that must still be the deployment's.
    if (fingerprint(await this.deps.deploymentEnv()) !== p.env)
      throw new PushError("RaceDetected", "Environment variables have changed during push");
    const stored = await storedModules(this.deps.engine);
    const before = new Set((stored?.rows ?? []).map((r) => r.path));
    // As Convex's, the schema and the auth config are modules of the push too (they define no function).
    const other = [p.authModule, p.schemaModule].filter((m): m is ModuleSource => m !== null);
    const after = new Set([...p.version.modules.keys(), ...other.map((m) => m.path)]);
    const moduleDiff = {
      added: [...after].filter((m) => !before.has(m) && !m.startsWith("_deps/")),
      removed: [...before].filter((m) => !after.has(m) && !m.startsWith("_deps/")),
    };
    // The schemas as `_schemas` stores them (JSON), before the push's commit replaces the active one.
    const schemaRows = (await this.deps.engine.query((db) =>
      db.asSystem(() => db.query(SCHEMAS_TABLE).collect()),
    )) as unknown as ({ _id: string; schema: string } & Record<string, unknown>)[];
    const previousSchema = schemaRows.find((r) => schemaStateOf(r) === "active")?.schema ?? null;
    const nextSchema = schemaRows.find((r) => r._id === p.schemaId)?.schema ?? null;
    const activeSchema = this.deps.engine.schema;
    // Convex's index diff of the push: in its audit event, and in the answer (as `SerializedIndexDiff`).
    const indexDiff = indexAuditDiff(activeSchema, p.schema);
    // The providers the push stores in `_auth` (none without an auth.config, as Convex's `app_auth`).
    const auth = p.auth === null ? [] : parseAuthConfig({ providers: p.auth } as never);
    // Convex's `node_version_diff`: the latest package's version before and after, when they differ.
    const previousNodeVersion = stored?.pkg.nodeVersion ?? null;
    const nodeVersionDiff =
      previousNodeVersion === p.nodeVersion
        ? null
        : { previous_version: previousNodeVersion, next_version: p.nodeVersion };
    const pkg = await writePackage(
      this.deps.modulesStore,
      [...p.modules, ...other],
      undefined,
      p.nodeVersion,
      p.external,
    ).catch((e) => {
      throw e instanceof ModulesTooLargeError ? new PushError(e.code, e.message, 400) : e;
    });
    let committed: Awaited<ReturnType<Engine["commitSchemaPush"]>> & {
      value: { unused: SourcePackage[]; crons: CronDiff; authDiff: { added: string[]; removed: string[] } };
    };
    try {
      // Analysis checked the targets (Convex's `validate_cron_jobs`) and kept the specs.
      const specs = new Map(Object.entries(p.version.analysis["crons.js"]?.cronSpecs ?? {}));
      committed = (await this.deps.engine.commitSchemaPush(p.schemaId, async (db) => {
        const unused = await writeCodeRows(db, pkg, p.version, other);
        // Convex's `AuthInfoModel::put`, in the push's commit: its diff is the push's `authDiff`.
        const authDiff = await putAuthInfo(db, auth);
        const crons = (await this.deps.cronExecutor.applyIn(db, specs)) as CronDiff;
        // Convex's `push_config_with_components`, in the push's commit.
        await insertAuditLogEvents(
          db,
          [
            auditEvents.pushConfigWithComponents({
              authDiff,
              create: !stored,
              moduleDiff,
              cronDiff: crons,
              indexDiff,
              udfConfigDiff: p.udfConfigDiff,
              schemaDiff:
                previousSchema === nextSchema ? null : { previous_schema: previousSchema, next_schema: nextSchema },
              message,
              nodeVersionDiff,
            }),
          ],
          actor,
        );
        return { unused, crons, authDiff };
      })) as typeof committed;
    } catch (e) {
      await this.deps.modulesStore.delete(pkg.storageKey).catch(() => {});
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
    for (const old of committed.value.unused) await this.deps.modulesStore.delete(old.storageKey).catch(() => {});
    return this.diff(
      moduleDiff,
      indexDiffJson(indexDiff),
      committed.value.crons,
      committed.value.authDiff,
      p.udfConfigDiff,
    );
  }

  private diff(
    moduleDiff: { added: string[]; removed: string[] } | [],
    indexDiff: ReturnType<typeof indexDiffJson>,
    crons: CronDiff,
    authDiff: { added: string[]; removed: string[] } = { added: [], removed: [] },
    udfConfigDiff: UdfServerVersionDiff | null = null,
  ) {
    return {
      authDiff,
      definitionDiffs: {},
      componentDiffs: {
        "": {
          diffType: { type: "modify" },
          moduleDiff: Array.isArray(moduleDiff) ? { added: [], removed: [] } : moduleDiff,
          udfConfigDiff,
          cronDiff: crons,
          indexDiff,
          schemaDiff: null,
        },
      },
    };
  }
}

type CronDiff = { added: string[]; updated: string[]; deleted: string[] };
const emptyCronDiff = (): CronDiff => ({ added: [], updated: [], deleted: [] });
