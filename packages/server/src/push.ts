// Pushing code (STUDY-35): Convex's deploy2 protocol (crates/local_backend/src/deploy_config2.rs,
// crates/application/src/deploy_config.rs), over what the engine and the code store do:
//
//   POST /api/get_config_hashes             the deployed modules' hashes, so a push sends only what changed
//   POST /api/deploy2/start_push            resolve the modules, load and analyze them (InvalidModules),
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
  documentTypeError,
  type Engine,
  indexReferenceError,
  insertAuditLogEvents,
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
  readPackage,
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
import type { CronJobExecutor } from "./cron-executor.ts";
import { describeUncaught } from "./errors.ts";
import { indexAuditDiff, indexDiffJson } from "./push-audit.ts";

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
function schemaExport(value: unknown): SchemaDefinition {
  if (value === undefined || value === null)
    throw new PushError(
      "MissingSchemaExportError",
      "Hit an error while evaluating your schema:\nSchema file missing default export.",
    );
  if (!((value as SchemaDefinition).tables instanceof Map)) throw invalidSchemaExport();
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
  };
  componentDefinitions?: unknown[];
};
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
};

const AUTH_CONFIG = AUTH_CONFIG_MODULE;
const emptySchema: SchemaDefinition = { tables: new Map(), schemaValidation: false };

export type PushDeps = {
  engine: Engine;
  modulesStore: BlobStore;
  cronExecutor: CronJobExecutor;
  /** Make a committed version live: functions, router, verifier, subscriptions. */
  install: (version: CodeVersion, auth: AuthInfo[], authModule: ModuleSource | null) => Promise<unknown>;
  /** The deployment's variables and the built-ins, as `auth.config` sees them (STUDY-37). */
  deploymentEnv: () => Promise<Record<string, string>>;
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

  /** Convex's `get_config_hashes`: what is deployed, by path. */
  async configHashes() {
    const stored = await storedModules(this.deps.engine);
    return {
      config: { functions: "", authInfo: [] },
      moduleHashes: (stored?.rows ?? []).map((r) => ({ path: r.path, hash: r.sha256, environment: r.environment })),
      nodeVersion: null,
    };
  }

  /** The push's modules: the changed ones sent, and the unchanged ones taken from the deployed package. */
  private async resolveModules(req: StartPushRequest): Promise<ModuleSource[]> {
    const changed = req.appDefinition?.changedModules ?? [];
    const unchanged = req.appDefinition?.unchangedModuleHashes ?? [];
    if (!unchanged.length) return changed;
    const stored = await storedModules(this.deps.engine);
    const sources = stored ? await readPackage(this.deps.modulesStore, stored.pkg.storageKey) : [];
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
  private async evaluateDefault(m: ModuleSource, env: Record<string, string>, code: string, what: string) {
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
      throw new PushError(code, `Hit an error while evaluating your ${what}:\n${message.trimEnd()}`);
    }
  }

  /**
   * Convex's `evaluate_schema` (STUDY-56): the push's schema only (no function module is analyzed), and what
   * pushing it would do to the indexes and the tables — the CLI's large-index and slow-validation checks.
   */
  async evaluateSchema(req: StartPushRequest) {
    if (req.componentDefinitions?.length)
      throw new PushError("ComponentsNotSupported", "Components are not supported by this deployment yet");
    let schema = emptySchema;
    const schemaModule = req.appDefinition?.schema;
    if (schemaModule) {
      const s = schemaExport(await this.evaluateDefault(schemaModule, {}, "InvalidSchema", "schema"));
      checkIndexReferences(s);
      schema = s;
    }
    const p = await this.deps.engine.evaluateSchema(schema);
    return {
      componentSchemaEvaluations: {
        "": {
          definitionPath: "",
          schemaValidation: schemaModule ? p.schemaValidation : false,
          tables: p.tables,
          indexes: p.indexes,
        },
      },
      newComponentDefinitions: [],
    };
  }

  async startPush(req: StartPushRequest) {
    if (req.componentDefinitions?.length)
      throw new PushError("ComponentsNotSupported", "Components are not supported by this deployment yet");
    const all = await this.resolveModules(req);
    const authModule = all.find((m) => m.path === AUTH_CONFIG);
    const modules = all.filter((m) => m.path !== AUTH_CONFIG);
    const config = await udfConfig(this.deps.engine, req.appDefinition?.udfServerVersion);
    let version: CodeVersion;
    try {
      version = await CodeVersion.load(modules, { seed: config.seed, timestamp: config.timestamp });
    } catch (e) {
      if (e instanceof InvalidModulesError) throw new PushError("InvalidModules", e.message);
      if (e instanceof FunctionExportError) throw new PushError(e.code, e.message);
      throw e;
    }
    let schema = emptySchema;
    const schemaModule = req.appDefinition?.schema;
    if (schemaModule) {
      const s = schemaExport(await this.evaluateDefault(schemaModule, {}, "InvalidSchema", "schema"));
      checkIndexReferences(s);
      schema = s;
    }
    const env = await this.deps.deploymentEnv();
    const auth = authModule ? await evaluateAuthConfig(this.deps.engine, authModule, env) : null;
    const analysis: Record<string, AnalyzedModule> = version.analysis;
    // As Convex's `start_push`: what the push does to the indexes, against the active schema (dry run too).
    const indexDiff = indexDiffJson(indexAuditDiff(this.deps.engine.schema, schema));
    if (req.dryRun) return this.response(version, schema, auth, analysis, { schemaId: null, indexDiff });
    let schemaId: string;
    try {
      ({ schemaId } = await this.deps.engine.startSchemaPush(schema));
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
    });
    return this.response(version, schema, auth, analysis, { schemaId, indexDiff });
  }

  private response(
    _version: CodeVersion,
    schema: SchemaDefinition,
    auth: unknown[] | null,
    analysis: Record<string, AnalyzedModule>,
    change: { schemaId: string | null; indexDiff: ReturnType<typeof indexDiffJson> },
  ) {
    return {
      environmentVariables: {},
      externalDepsId: null,
      componentDefinitionPackages: {},
      appAuth: auth ?? [],
      analysis: {
        "": {
          definition: null,
          schema: schema === emptySchema ? null : schemaToJson(schema),
          functions: analysis,
          udfConfig: null,
        },
      },
      app: { definitionPath: "", componentPath: "", args: {}, childComponents: [] },
      schemaChange: {
        allocatedComponentIds: {},
        schemaIds: change.schemaId ? { "": change.schemaId } : {},
        indexDiffs: { "": change.indexDiff },
      },
    };
  }

  /** Convex's `wait_for_schema`: until the change is no longer in progress, or `timeoutMs`. */
  async waitForSchema(req: { schemaChange?: { schemaIds?: Record<string, string> }; timeoutMs?: number }) {
    const schemaId = req.schemaChange?.schemaIds?.[""];
    if (!schemaId) return { type: "complete" };
    const deadline = Date.now() + Math.min(req.timeoutMs ?? 10_000, 60_000);
    for (;;) {
      const s = await this.deps.engine.schemaPushStatus(schemaId);
      if (s.type === "failed") return { type: "failed", error: s.error, componentPath: "", tableName: s.tableName };
      if (s.type !== "inProgress") return { type: s.type };
      if (Date.now() >= deadline)
        return {
          type: "inProgress",
          components: {
            "": {
              schemaValidationComplete: s.schemaValidationComplete,
              indexesComplete: s.indexesComplete,
              indexesTotal: s.indexesTotal,
            },
          },
        };
      await Bun.sleep(100);
    }
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
    const pkg = await writePackage(this.deps.modulesStore, [...p.modules, ...other]);
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
