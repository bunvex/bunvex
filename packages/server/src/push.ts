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
import { parseAuthConfig } from "@bunvex/auth";
import { type Engine, type SchemaDefinition, SchemaPushError, schemaToJson } from "@bunvex/core";
import type { BlobStore } from "@bunvex/file-storage";
import {
  readPackage,
  type SourcePackage,
  storedModules,
  udfConfig,
  writeCodeRows,
  writePackage,
} from "./code-store.ts";
import { type AnalyzedModule, CodeVersion, InvalidModulesError, type ModuleSource } from "./code-version.ts";
import type { CronJobExecutor } from "./cron-executor.ts";
import { describeUncaught } from "./errors.ts";

/** A push that cannot go on, as Convex's `ErrorMetadata` (400 unless said otherwise). */
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
  };
  componentDefinitions?: unknown[];
};
type Pending = {
  version: CodeVersion;
  modules: ModuleSource[];
  schema: SchemaDefinition;
  auth: unknown[] | null;
  schemaId: string;
  addedIndexes: string[];
};

const AUTH_CONFIG = "auth.config.js";
const emptySchema: SchemaDefinition = { tables: new Map(), schemaValidation: false };

export type PushDeps = {
  engine: Engine;
  modulesStore: BlobStore;
  cronExecutor: CronJobExecutor;
  /** Make a committed version live: functions, router, verifier, subscriptions. */
  install: (version: CodeVersion, auth: unknown[] | null) => Promise<unknown>;
  /** The environment auth.config sees until deployment environment variables exist (owner, 2026-10-02). */
  authEnv: () => Record<string, string>;
};

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

  async startPush(req: StartPushRequest) {
    if (req.componentDefinitions?.length)
      throw new PushError("ComponentsNotSupported", "Components are not supported by this deployment yet");
    const all = await this.resolveModules(req);
    const authModule = all.find((m) => m.path === AUTH_CONFIG);
    const modules = all.filter((m) => m.path !== AUTH_CONFIG);
    const config = await udfConfig(this.deps.engine);
    let version: CodeVersion;
    try {
      version = await CodeVersion.load(modules, { seed: config.seed, timestamp: config.timestamp });
    } catch (e) {
      if (e instanceof InvalidModulesError) throw new PushError("InvalidModules", e.message);
      throw e;
    }
    let schema = emptySchema;
    const schemaModule = req.appDefinition?.schema;
    if (schemaModule) {
      const s = (await this.evaluateDefault(schemaModule, {}, "InvalidSchema", "schema")) as SchemaDefinition;
      if (!(s?.tables instanceof Map))
        throw new PushError(
          "InvalidSchema",
          "Hit an error while evaluating your schema:\nThe default export is not a schema (defineSchema(...))",
        );
      schema = s;
    }
    let auth: unknown[] | null = null;
    if (authModule) {
      const c = await this.evaluateDefault(authModule, this.deps.authEnv(), "InvalidAuthConfig", "auth config");
      try {
        parseAuthConfig(c);
      } catch (e) {
        throw new PushError("InvalidAuthConfig", (e as Error).message);
      }
      auth = (c as { providers: unknown[] }).providers;
    }
    const analysis: Record<string, AnalyzedModule> = version.analysis;
    if (req.dryRun) return this.response(version, schema, auth, analysis, { schemaId: null, addedIndexes: [] });
    const { schemaId, addedIndexes } = await this.deps.engine.startSchemaPush(schema);
    this.pending.set(schemaId, { version, modules, schema, auth, schemaId, addedIndexes });
    return this.response(version, schema, auth, analysis, { schemaId, addedIndexes });
  }

  private response(
    _version: CodeVersion,
    schema: SchemaDefinition,
    auth: unknown[] | null,
    analysis: Record<string, AnalyzedModule>,
    change: { schemaId: string | null; addedIndexes: string[] },
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
        indexDiffs: { "": { added_indexes: change.addedIndexes, removed_indexes: [] } },
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
  async finishPush(req: { startPush?: { schemaChange?: { schemaIds?: Record<string, string> } }; dryRun?: boolean }) {
    const schemaId = req.startPush?.schemaChange?.schemaIds?.[""];
    const p = schemaId ? this.pending.get(schemaId) : undefined;
    if (!p) throw new PushError("RaceDetected", "Schema was overwritten by another push.");
    if (req.dryRun) return this.diff(p, [], { enabled: [], disabled: [], dropped: [] }, emptyCronDiff());
    const before = new Set(((await storedModules(this.deps.engine))?.rows ?? []).map((r) => r.path));
    const pkg = await writePackage(this.deps.modulesStore, p.modules);
    let committed: Awaited<ReturnType<Engine["commitSchemaPush"]>> & {
      value: { unused: SourcePackage[]; crons: CronDiff };
    };
    try {
      // Analysis checked the targets (Convex's `validate_cron_jobs`) and kept the specs.
      const specs = new Map(Object.entries(p.version.analysis["crons.js"]?.cronSpecs ?? {}));
      committed = (await this.deps.engine.commitSchemaPush(p.schemaId, async (db) => ({
        unused: await writeCodeRows(db, pkg, p.version),
        crons: (await this.deps.cronExecutor.applyIn(db, specs)) as CronDiff,
      }))) as typeof committed;
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
    await this.deps.install(p.version, p.auth);
    this.deps.cronExecutor.refresh();
    for (const old of committed.value.unused) await this.deps.modulesStore.delete(old.storageKey).catch(() => {});
    const after = new Set(p.version.modules.keys());
    const moduleDiff = {
      added: [...after].filter((m) => !before.has(m) && !m.startsWith("_deps/")),
      removed: [...before].filter((m) => !after.has(m) && !m.startsWith("_deps/")),
    };
    return this.diff(p, moduleDiff, committed.indexDiff, committed.value.crons);
  }

  private diff(
    p: Pending,
    moduleDiff: { added: string[]; removed: string[] } | [],
    index: { enabled: string[]; disabled: string[]; dropped: string[] },
    crons: CronDiff,
  ) {
    return {
      authDiff: { added: [], removed: [] },
      definitionDiffs: {},
      componentDiffs: {
        "": {
          diffType: { type: "modify" },
          moduleDiff: Array.isArray(moduleDiff) ? { added: [], removed: [] } : moduleDiff,
          udfConfigDiff: null,
          cronDiff: crons,
          indexDiff: {
            added_indexes: p.addedIndexes,
            removed_indexes: index.dropped,
            enabled_indexes: index.enabled,
            disabled_indexes: index.disabled,
          },
          schemaDiff: null,
        },
      },
    };
  }
}

type CronDiff = { added: string[]; updated: string[]; deleted: string[] };
const emptyCronDiff = (): CronDiff => ({ added: [], updated: [], deleted: [] });
