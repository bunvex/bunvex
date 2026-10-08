// Where deployed code lives (STUDY-35), as Convex keeps it:
//   `_source_packages` — one row per pushed package, pointing at its blob in the modules store (Convex: a zip
//     in module storage; here one gzip-compressed JSON blob, DV-166);
//   `_modules` — one row per module: `{ path, sourcePackageId, environment, sha256, analyzeResult }`;
//   `_udf_config` — the import phase's seed and time (Convex's `UdfConfig`), so a version imports the same way
//     every time it is loaded.
// The rows have Convex's shapes (STUDY-134, DV-424): crates/model/src/source_packages/types.rs
// `SerializedSourcePackage` (`sha256` as bytes, `packageSize` as int64 sizes, `externalPackageId` and
// `nodeVersion` null) and crates/model/src/modules/types.rs `SerializedModuleMetadata` (`sha256` in base64,
// `analyzeResult` as `SerializedAnalyzedModule`, positions as int64). Code in memory keeps its own types: rows are
// encoded when written and decoded when read, here. As in Convex, the schema and the auth config are modules too.
// The modules store is its own use case (`modules`), apart from user files, whose orphan sweep would
// otherwise delete packages (F3).
import { type Engine, MODULES_TABLE, SOURCE_PACKAGES_TABLE, type Tx, UDF_CONFIG_TABLE } from "@bunvex/core";
import type { BlobStore } from "@bunvex/file-storage";
import type { Value } from "@bunvex/values";
import { type AnalyzedModule, CodeVersion, type ModuleSource, moduleHash, moduleName } from "./code-version.ts";
import { cronSpecOf, cronSpecsRow, msOfNs, nsOfMs } from "./cron-rows.ts";
import { SERVER_VERSION } from "./server-version.ts";
import type { SourcePosition } from "./source-position.ts";

/** Convex's unzipped package limit (crates/model/src/source_packages/types.rs). */
export const MAX_UNZIPPED_PACKAGE_BYTES = 230 * 1024 * 1024;

/** A package as `_source_packages` stores it (Convex's `SerializedSourcePackage`). */
export type SourcePackageFields = {
  storageKey: string;
  sha256: ArrayBuffer;
  externalPackageId: null;
  packageSize: { zippedSizeBytes: bigint; unzippedSizeBytes: bigint };
  nodeVersion: null;
};
export type SourcePackage = SourcePackageFields & { _id: string };
/** A module's row, decoded: its hash in hex (the push's wire form), its analysis with plain numbers. */
export type ModuleRow = {
  _id: string;
  path: string;
  sourcePackageId: string;
  environment: "isolate" | "node";
  sha256: string;
  analyzeResult: AnalyzedModule | null;
};
export type UdfConfig = { serverVersion: string; seed: Uint32Array; timestamp: number };
/** Convex's `UdfServerVersionDiff`: what a push changed the server version from, and to. */
export type UdfServerVersionDiff = { previous_version: string; next_version: string };

/** The schema's module, stored with the functions as Convex's (`AppDefinitionConfig::all_modules`). */
export const SCHEMA_MODULE = "schema.js";

/** Store a push's modules as one blob; the package's row (its key, hash and sizes). */
export async function writePackage(store: BlobStore, modules: ModuleSource[]): Promise<SourcePackageFields> {
  const json = JSON.stringify({ modules });
  if (json.length > MAX_UNZIPPED_PACKAGE_BYTES)
    throw new Error(
      `Total module size exceeded the unzipped maximum (${json.length} > ${MAX_UNZIPPED_PACKAGE_BYTES} bytes)`,
    );
  const bytes = new TextEncoder().encode(json);
  const written = await store.put(Bun.gzipSync(bytes));
  return {
    storageKey: written.key,
    sha256: written.sha256.slice().buffer,
    externalPackageId: null,
    packageSize: { zippedSizeBytes: BigInt(written.size), unzippedSizeBytes: BigInt(bytes.length) },
    nodeVersion: null,
  };
}

export async function readPackage(store: BlobStore, storageKey: string): Promise<ModuleSource[]> {
  const stream = await store.get(storageKey);
  if (!stream) throw new Error(`the code package ${storageKey} is missing from the modules store`);
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  return (JSON.parse(new TextDecoder().decode(Bun.gunzipSync(bytes))) as { modules: ModuleSource[] }).modules;
}

/**
 * The deployed package's modules, or null when bunvex cannot read it (another binary's package, such as the
 * zip Convex writes, or a damaged blob): it is ignored with a log line, as if nothing were deployed, and the
 * next deploy replaces it (STUDY-139 P4).
 */
export async function readablePackage(
  store: BlobStore,
  storageKey: string,
  warn: (message: string) => void = console.warn,
): Promise<ModuleSource[] | null> {
  try {
    return await readPackage(store, storageKey);
  } catch (e) {
    warn(
      `bunvex: the deployed code package ${storageKey} cannot be read (${e instanceof Error ? e.message : e}); ` +
        "it is ignored until the next deploy replaces it",
    );
    return null;
  }
}

type PositionRow = { path: string; start_lineno: bigint; start_col: bigint } | null;
const positionRow = (p: SourcePosition | null): PositionRow =>
  p && { path: p.path, start_lineno: BigInt(p.start_lineno), start_col: BigInt(p.start_col) };
const positionFromRow = (p: PositionRow): SourcePosition | null =>
  p && { path: p.path, start_lineno: Number(p.start_lineno), start_col: Number(p.start_col) };

/** A module's analysis as `_modules` stores it: Convex's `SerializedAnalyzedModule`, positions in int64. */
function analysisRow(a: AnalyzedModule): Value {
  return {
    functions: a.functions.map((f) => ({ ...f, pos: positionRow(f.pos) })),
    httpRoutes: a.httpRoutes === null ? null : a.httpRoutes.map((r) => ({ route: r.route, pos: positionRow(r.pos) })),
    // The crons as Convex's `[{identifier, spec}]` (cron-rows.ts).
    cronSpecs: cronSpecsRow(a.cronSpecs),
    sourceMapped: null,
  } as unknown as Value;
}

function analysisFromRow(row: Record<string, unknown> | null): AnalyzedModule | null {
  if (!row) return null;
  const r = row as {
    functions: (Omit<AnalyzedModule["functions"][number], "pos"> & { pos: PositionRow })[];
    httpRoutes: { route: { path: string; method: string }; pos: PositionRow }[] | null;
    cronSpecs: { identifier: string; spec: Record<string, unknown> }[] | null;
  };
  return {
    functions: r.functions.map((f) => ({ ...f, pos: positionFromRow(f.pos) })),
    httpRoutes:
      r.httpRoutes === null ? null : r.httpRoutes.map((h) => ({ route: h.route, pos: positionFromRow(h.pos) })),
    cronSpecs:
      r.cronSpecs === null ? null : Object.fromEntries(r.cronSpecs.map((c) => [c.identifier, cronSpecOf(c.spec)])),
  };
}

/** A module that defines no function (the schema, the auth config): Convex analyzes it to nothing. */
const NOTHING: AnalyzedModule = { functions: [], httpRoutes: null, cronSpecs: null };

const hexToBase64 = (hex: string) => Buffer.from(hex, "hex").toString("base64");
const base64ToHex = (b64: string) => Buffer.from(b64, "base64").toString("hex");

/**
 * The deployment's import-phase seed and time, made once (Convex keeps them unless the server version changes).
 * The row is Convex's `UdfConfig`: `{serverVersion, importPhaseRngSeed: bytes, importPhaseUnixTimestamp}`, the
 * time an int64 of nanoseconds. `serverVersion` is what a push sends (`udfServerVersion`: the CLI's package
 * version, as Convex's); without one, the stored row is used as it is, or made with this server's version.
 */
export async function udfConfig(
  engine: Engine,
  serverVersion?: string,
): Promise<UdfConfig & { diff: UdfServerVersionDiff | null }> {
  // Drawn outside the transaction: randomness is refused inside one (determinism).
  const fresh = crypto.getRandomValues(new Uint32Array(8));
  return engine.mutation((db) =>
    db.asSystem(async () => {
      const row = (await db.query(UDF_CONFIG_TABLE).first()) as Record<string, unknown> | null;
      if (row && (serverVersion === undefined || row.serverVersion === serverVersion))
        return {
          serverVersion: row.serverVersion as string,
          seed: new Uint32Array(row.importPhaseRngSeed as ArrayBuffer),
          timestamp: msOfNs(row.importPhaseUnixTimestamp as bigint),
          diff: null,
        };
      const version = serverVersion ?? SERVER_VERSION;
      // As Convex's `UdfConfigModel::set`: a diff when the version changed, or with no row before.
      const diff = {
        previous_version: row ? (row.serverVersion as string) : "Unspecified version",
        next_version: version,
      };
      const seed = fresh;
      const timestamp = Date.now();
      const fields = {
        serverVersion: version,
        importPhaseRngSeed: seed.buffer.slice(0),
        importPhaseUnixTimestamp: nsOfMs(timestamp),
      };
      if (row) await db.replace(UDF_CONFIG_TABLE, row._id as string, fields);
      else await db.insert(UDF_CONFIG_TABLE, fields);
      return { serverVersion: version, seed, timestamp, diff };
    }),
  ) as Promise<UdfConfig & { diff: UdfServerVersionDiff | null }>;
}

/**
 * The import-phase seed and time for a module that is not deployed (the function tester, STUDY-119), as
 * Convex's `execute_standalone_module`: the deployment's, whatever server version wrote them; with none yet, a
 * fresh seed and the current time, as if the most recent version had pushed. Nothing is written: Convex sets
 * them in a transaction it never commits.
 */
export async function peekUdfConfig(engine: Engine): Promise<UdfConfig> {
  // Drawn outside the transaction: randomness is refused inside one (determinism).
  const fresh = crypto.getRandomValues(new Uint32Array(8));
  const now = Date.now();
  const row = (await engine.query((db) => db.asSystem(() => db.query(UDF_CONFIG_TABLE).first()))) as Record<
    string,
    unknown
  > | null;
  if (row)
    return {
      serverVersion: row.serverVersion as string,
      seed: new Uint32Array(row.importPhaseRngSeed as ArrayBuffer),
      timestamp: msOfNs(row.importPhaseUnixTimestamp as bigint),
    };
  return { serverVersion: SERVER_VERSION, seed: fresh, timestamp: now };
}

/**
 * The root component's rows, as a push leaves them in Convex (STUDY-133 §12 M2): the app's definition in
 * `_component_definitions` and its instance in `_components` (Convex's `SerializedComponentDefinitionMetadata`
 * and `SerializedComponentMetadata` for `ComponentType::App`). bunvex has no other component (DV-55), so they are
 * written once and never change.
 */
async function ensureRootComponent(db: Tx) {
  const definitions = (await db.query("_component_definitions").collect()) as Record<string, unknown>[];
  let root = definitions.find((d) => d.path === "")?._id as string | undefined;
  root ??= await db.insert("_component_definitions", {
    path: "",
    definitionType: { type: "app" },
    childComponents: [],
    httpMounts: {},
    httpPrefix: null,
    exports: { type: "branch", branch: [] },
    envVars: null,
  });
  const components = (await db.query("_components").collect()) as Record<string, unknown>[];
  if (!components.some((c) => c.parent === null))
    await db.insert("_components", {
      definitionId: root,
      parent: null,
      name: null,
      args: null,
      env: null,
      state: "active",
      httpPrefix: null,
    });
}

/**
 * In the push's transaction (Convex's `ModuleModel.apply` / `SourcePackageModel.put`): the package row, and
 * the module rows replaced by the version's. Returns the packages no module points at any more.
 */
export async function writeCodeRows(
  db: Tx,
  pkg: SourcePackageFields,
  version: CodeVersion,
  /** The package's modules that define no function (the schema, the auth config): rows analyzed to nothing. */
  other: ModuleSource[] = [],
): Promise<SourcePackage[]> {
  return db.asSystem(async () => {
    const sourcePackageId = await db.insert(SOURCE_PACKAGES_TABLE, pkg);
    const old = (await db.query(MODULES_TABLE).collect()) as unknown as ModuleRow[];
    const byPath = new Map(old.map((m) => [m.path, m]));
    const modules = [
      ...[...version.modules].map(([path, l]) => ({ path, source: l.source, hash: l.hash, a: version.analysis[path] })),
      ...other.map((m) => ({ path: m.path, source: m, hash: moduleHash(m), a: NOTHING })),
    ];
    for (const { path, source, hash, a } of modules) {
      const row = {
        path,
        sourcePackageId,
        environment: source.environment,
        sha256: hexToBase64(hash),
        analyzeResult: a ? analysisRow(a) : null,
      };
      const cur = byPath.get(path);
      if (cur) await db.replace(MODULES_TABLE, cur._id, row);
      else await db.insert(MODULES_TABLE, row);
      byPath.delete(path);
    }
    for (const gone of byPath.values()) await db.delete(MODULES_TABLE, gone._id);
    await ensureRootComponent(db);
    const unused: SourcePackage[] = [];
    for (const p of (await db.query(SOURCE_PACKAGES_TABLE).collect()) as unknown as SourcePackage[])
      if (p._id !== sourcePackageId) {
        await db.delete(SOURCE_PACKAGES_TABLE, p._id);
        unused.push(p);
      }
    return unused;
  }) as Promise<SourcePackage[]>;
}

/** The modules as stored: their rows and the package they live in, or null when nothing was deployed. */
export async function storedModules(engine: Engine): Promise<{ rows: ModuleRow[]; pkg: SourcePackage } | null> {
  return engine.query(async (db) =>
    db.asSystem(async () => {
      const rows = ((await db.query(MODULES_TABLE).collect()) as Record<string, unknown>[]).map(
        (r): ModuleRow => ({
          _id: r._id as string,
          path: r.path as string,
          sourcePackageId: r.sourcePackageId as string,
          environment: r.environment as ModuleRow["environment"],
          sha256: base64ToHex(r.sha256 as string),
          analyzeResult: analysisFromRow(r.analyzeResult as Record<string, unknown> | null),
        }),
      );
      if (!rows.length) return null;
      const pkg = (await db.get(SOURCE_PACKAGES_TABLE, rows[0]!.sourcePackageId)) as unknown as SourcePackage | null;
      if (!pkg) throw new Error(`the code package ${rows[0]!.sourcePackageId} of ${rows[0]!.path} is missing`);
      return { rows, pkg };
    }),
  );
}

/**
 * The auth config travels in the package and has its module row, as Convex's, but defines no function: it is
 * not loaded with them (STUDY-35, STUDY-37).
 */
export const AUTH_CONFIG_MODULE = "auth.config.js";

/**
 * The latest deployed code (what a deployable server runs on start): the version, loaded, and the
 * stored `auth.config.js`, if any; or null.
 */
export async function loadLatestCode(
  engine: Engine,
  store: BlobStore,
  env: Record<string, string> = {},
): Promise<{ version: CodeVersion; authConfig: ModuleSource | null } | null> {
  const stored = await storedModules(engine);
  if (!stored) return null;
  const sources = await readablePackage(store, stored.pkg.storageKey);
  if (!sources) return null;
  const config = await udfConfig(engine);
  const version = await CodeVersion.load(
    sources.filter((m) => m.path !== AUTH_CONFIG_MODULE && m.path !== SCHEMA_MODULE),
    { seed: config.seed, timestamp: config.timestamp, env },
  );
  return { version, authConfig: sources.find((m) => m.path === AUTH_CONFIG_MODULE) ?? null };
}

/** The latest deployed version, loaded, or null. */
export async function loadLatestCodeVersion(
  engine: Engine,
  store: BlobStore,
  env: Record<string, string> = {},
): Promise<CodeVersion | null> {
  return (await loadLatestCode(engine, store, env))?.version ?? null;
}

export { moduleName };
