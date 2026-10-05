// Where deployed code lives (STUDY-35), as Convex keeps it:
//   `_source_packages` — one row per pushed package, pointing at its blob in the modules store (Convex: a zip
//     in module storage; here one gzip-compressed JSON blob, DV-166);
//   `_modules` — one row per module: `{ path, sourcePackageId, environment, sha256, analyzeResult }`;
//   `_udf_config` — the import phase's seed and time (Convex's `UdfConfig`), so a version imports the same way
//     every time it is loaded.
// The modules store is its own use case (`modules`), apart from user files, whose orphan sweep would
// otherwise delete packages (F3).
import { type Engine, MODULES_TABLE, SOURCE_PACKAGES_TABLE, type Tx, UDF_CONFIG_TABLE } from "@bunvex/core";
import type { BlobStore } from "@bunvex/file-storage";
import { type AnalyzedModule, CodeVersion, type ModuleSource, moduleName } from "./code-version.ts";
import { cronSpecsRow, msOfNs, nsOfMs } from "./cron-rows.ts";
import { SERVER_VERSION } from "./server-version.ts";

/** Convex's unzipped package limit (crates/model/src/source_packages/types.rs). */
export const MAX_UNZIPPED_PACKAGE_BYTES = 230 * 1024 * 1024;

export type SourcePackage = { _id: string; storageKey: string; sha256: string; packageSize: number };
export type ModuleRow = {
  _id: string;
  path: string;
  sourcePackageId: string;
  environment: "isolate" | "node";
  sha256: string;
  analyzeResult: AnalyzedModule | null;
};
export type UdfConfig = { serverVersion: string; seed: Uint32Array; timestamp: number };

/** A module's analysis as its `_modules` row holds it: the crons as Convex's `[{identifier, spec}]` (cron-rows.ts). */
const analysisRow = (a: AnalyzedModule | null) => (a === null ? null : { ...a, cronSpecs: cronSpecsRow(a.cronSpecs) });

/** Store a push's modules as one blob; its key, hash and size. */
export async function writePackage(store: BlobStore, modules: ModuleSource[]) {
  const json = JSON.stringify({ modules });
  if (json.length > MAX_UNZIPPED_PACKAGE_BYTES)
    throw new Error(
      `Total module size exceeded the unzipped maximum (${json.length} > ${MAX_UNZIPPED_PACKAGE_BYTES} bytes)`,
    );
  const written = await store.put(Bun.gzipSync(new TextEncoder().encode(json)));
  return { storageKey: written.key, sha256: Buffer.from(written.sha256).toString("hex"), packageSize: written.size };
}

export async function readPackage(store: BlobStore, storageKey: string): Promise<ModuleSource[]> {
  const stream = await store.get(storageKey);
  if (!stream) throw new Error(`the code package ${storageKey} is missing from the modules store`);
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  return (JSON.parse(new TextDecoder().decode(Bun.gunzipSync(bytes))) as { modules: ModuleSource[] }).modules;
}

/**
 * The deployment's import-phase seed and time, made once (Convex keeps them unless the server version changes).
 * The row is Convex's `UdfConfig`: `{serverVersion, importPhaseRngSeed: bytes, importPhaseUnixTimestamp}`, the
 * time an int64 of nanoseconds. `serverVersion` is what a push sends (`udfServerVersion`: the CLI's package
 * version, as Convex's); without one, the stored row is used as it is, or made with this server's version.
 */
export async function udfConfig(engine: Engine, serverVersion?: string): Promise<UdfConfig> {
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
        };
      const version = serverVersion ?? SERVER_VERSION;
      const seed = fresh;
      const timestamp = Date.now();
      const fields = {
        serverVersion: version,
        importPhaseRngSeed: seed.buffer.slice(0),
        importPhaseUnixTimestamp: nsOfMs(timestamp),
      };
      if (row) await db.replace(UDF_CONFIG_TABLE, row._id as string, fields);
      else await db.insert(UDF_CONFIG_TABLE, fields);
      return { serverVersion: version, seed, timestamp };
    }),
  ) as Promise<UdfConfig>;
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
 * In the push's transaction (Convex's `ModuleModel.apply` / `SourcePackageModel.put`): the package row, and
 * the module rows replaced by the version's. Returns the packages no module points at any more.
 */
export async function writeCodeRows(
  db: Tx,
  pkg: { storageKey: string; sha256: string; packageSize: number },
  version: CodeVersion,
): Promise<SourcePackage[]> {
  return db.asSystem(async () => {
    const sourcePackageId = await db.insert(SOURCE_PACKAGES_TABLE, pkg);
    const old = (await db.query(MODULES_TABLE).collect()) as unknown as ModuleRow[];
    const byPath = new Map(old.map((m) => [m.path, m]));
    for (const [path, l] of version.modules) {
      const row = {
        path,
        sourcePackageId,
        environment: l.source.environment,
        sha256: l.hash,
        analyzeResult: analysisRow(version.analysis[path] ?? null),
      };
      const cur = byPath.get(path);
      if (cur) await db.replace(MODULES_TABLE, cur._id, row);
      else await db.insert(MODULES_TABLE, row);
      byPath.delete(path);
    }
    for (const gone of byPath.values()) await db.delete(MODULES_TABLE, gone._id);
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
      const rows = (await db.query(MODULES_TABLE).collect()) as unknown as ModuleRow[];
      if (!rows.length) return null;
      const pkg = (await db.get(SOURCE_PACKAGES_TABLE, rows[0]!.sourcePackageId)) as unknown as SourcePackage | null;
      if (!pkg) throw new Error(`the code package ${rows[0]!.sourcePackageId} of ${rows[0]!.path} is missing`);
      return { rows, pkg };
    }),
  );
}

/** The auth config travels in the package beside the modules, but is not one (STUDY-35, STUDY-37). */
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
  const sources = await readPackage(store, stored.pkg.storageKey);
  const config = await udfConfig(engine);
  const version = await CodeVersion.load(
    sources.filter((m) => m.path !== AUTH_CONFIG_MODULE),
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
