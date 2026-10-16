// Where deployed code lives (STUDY-35), as Convex keeps it:
//   `_source_packages` — one row per pushed package, pointing at its blob in the modules store: Convex's zip
//     (crates/model/src/source_packages/upload_download.rs; DV-166);
//   `_modules` — one row per module: `{ path, sourcePackageId, environment, sha256, analyzeResult }`;
//   `_udf_config` — the import phase's seed and time (Convex's `UdfConfig`), so a version imports the same way
//     every time it is loaded.
// The rows have Convex's shapes (STUDY-134, DV-424): crates/model/src/source_packages/types.rs
// `SerializedSourcePackage` (`sha256` as bytes, `packageSize` as int64 sizes, `externalPackageId` the push's
// `_external_deps_packages` row or null, STUDY-148; `nodeVersion` the push's or null, STUDY-145) and crates/model/src/modules/types.rs `SerializedModuleMetadata` (`sha256` in base64,
// `analyzeResult` as `SerializedAnalyzedModule`, positions as int64). Code in memory keeps its own types: rows are
// encoded when written and decoded when read, here. As in Convex, the schema and the auth config are modules too.
// The modules store is its own use case (`modules`), apart from user files, whose orphan sweep would
// otherwise delete packages (F3).
import {
  type Engine,
  formatBytes,
  type KnobEnv,
  knob,
  MODULES_TABLE,
  SOURCE_PACKAGES_TABLE,
  type Tx,
  UDF_CONFIG_TABLE,
} from "@bunvex/core";
import type { BlobStore } from "@bunvex/file-storage";
import type { Value } from "@bunvex/values";
import { type AnalyzedModule, CodeVersion, type ModuleSource, moduleHash, moduleName } from "./code-version.ts";
import { cronSpecOf, cronSpecsRow, msOfNs, nsOfMs } from "./cron-rows.ts";
import { externalDepsPath, externalDepsRow } from "./external-deps.ts";
import { SERVER_VERSION } from "./server-version.ts";
import type { SourcePosition } from "./source-position.ts";
import { bytesSource, entryBytes, ZipReader } from "./zip-reader.ts";
import { zipInMemory } from "./zip-writer.ts";

/** Convex's package limits (crates/model/src/source_packages/types.rs): 230 000 000 bytes unzipped, and the
 *  `MAX_ZIPPED_PACKAGES_SIZE` knob zipped (90 000 000 by default). A package at a limit or over it is refused. */
export const MAX_UNZIPPED_PACKAGE_BYTES = 230_000_000;
export const MAX_ZIPPED_PACKAGE_BYTES = 90_000_000;

/** A package over a limit: Convex's 400 `ModulesTooLarge` (`PackageSize::verify_size`). */
export class ModulesTooLargeError extends Error {
  readonly code = "ModulesTooLarge";
}

/** The zipped limit: the `MAX_ZIPPED_PACKAGES_SIZE` knob, a byte count, else Convex's default. */
function zippedLimit(env: KnobEnv = process.env): number {
  return knob("MAX_ZIPPED_PACKAGES_SIZE", MAX_ZIPPED_PACKAGE_BYTES, "uint", env);
}

/** A package as `_source_packages` stores it (Convex's `SerializedSourcePackage`). */
export type SourcePackageFields = {
  storageKey: string;
  sha256: ArrayBuffer;
  /** The push's `_external_deps_packages` row (STUDY-148), or null. */
  externalPackageId: string | null;
  packageSize: { zippedSizeBytes: bigint; unzippedSizeBytes: bigint };
  /** The push's `node.nodeVersion` ("20", "22" or "24"), or null (STUDY-145). */
  nodeVersion: string | null;
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

/** A package's `metadata.json` (Convex's `MetadataJson`). */
type PackageMetadata = {
  modulePaths: string[];
  moduleEnvironments: [string, "isolate" | "node"][] | null;
  externalDepsStorageKey: string | null;
};

/** A push's external packages (STUDY-148), as its package records them: the row, its blob and its sizes. */
export type PackageExternalDeps = { id: string; storageKey: string; zipped: number; unzipped: number };

/**
 * A push's modules as Convex's package (`write_package`): a zip with each module's source at `modules/<path>`,
 * its source map at `modules/<path>.map`, by path, then `metadata.json` (`externalDepsStorageKey` the external
 * packages' blob, STUDY-148); the unzipped size counts the sources, the maps and the metadata, as Convex's. Over a
 * limit, the external packages' sizes added (Convex's `upload_packages` checks the total), it throws Convex's
 * `ModulesTooLarge` (`verify_size`), which `start_push` meets first, before anything is analyzed (Convex uploads
 * and checks the package there).
 */
export function buildPackage(
  modules: ModuleSource[],
  limits: { zipped: number; unzipped: number } = { zipped: zippedLimit(), unzipped: MAX_UNZIPPED_PACKAGE_BYTES },
  external: PackageExternalDeps | null = null,
): { zip: Uint8Array; unzipped: number } {
  const enc = new TextEncoder();
  const entries: { name: string; data: Uint8Array }[] = [];
  const metadata: PackageMetadata = {
    modulePaths: [],
    moduleEnvironments: [],
    externalDepsStorageKey: external?.storageKey ?? null,
  };
  let unzipped = 0;
  for (const m of [...modules].sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0))) {
    const source = enc.encode(m.source);
    entries.push({ name: `modules/${m.path}`, data: source });
    metadata.modulePaths.push(m.path);
    metadata.moduleEnvironments!.push([m.path, m.environment]);
    unzipped += source.length;
    if (m.sourceMap !== undefined) {
      const map = enc.encode(m.sourceMap);
      entries.push({ name: `modules/${m.path}.map`, data: map });
      metadata.modulePaths.push(`${m.path}.map`);
      unzipped += map.length;
    }
  }
  const metadataJson = enc.encode(JSON.stringify(metadata));
  entries.push({ name: "metadata.json", data: metadataJson });
  unzipped += metadataJson.length;
  const zip = zipInMemory(entries);
  checkSize(zip.length + (external?.zipped ?? 0), unzipped + (external?.unzipped ?? 0), limits);
  return { zip, unzipped };
}

/** Convex's `verify_size` over a push's total: the zipped size, then the unzipped one, in binary units (humansize's BINARY). */
function checkSize(zippedTotal: number, unzippedTotal: number, limits: { zipped: number; unzipped: number }) {
  if (zippedTotal >= limits.zipped)
    throw new ModulesTooLargeError(
      `Total module size exceeded the zipped maximum (${formatBytes(zippedTotal)} > maximum size ${formatBytes(limits.zipped)})`,
    );
  if (unzippedTotal >= limits.unzipped)
    throw new ModulesTooLargeError(
      `Total module size exceeded the unzipped maximum (${formatBytes(unzippedTotal)} > maximum size ${formatBytes(limits.unzipped)})`,
    );
}

/**
 * The size check of a push with components (Convex's `upload_packages`): one package for the app, one per component
 * definition, the external packages counted once, and ONE check over the total.
 */
export function checkPackagesSize(
  packages: ModuleSource[][],
  external: PackageExternalDeps | null = null,
  limits: { zipped: number; unzipped: number } = { zipped: zippedLimit(), unzipped: MAX_UNZIPPED_PACKAGE_BYTES },
) {
  const unlimited = { zipped: Number.POSITIVE_INFINITY, unzipped: Number.POSITIVE_INFINITY };
  let zipped = external?.zipped ?? 0;
  let unzipped = external?.unzipped ?? 0;
  for (const modules of packages) {
    const p = buildPackage(modules, unlimited);
    zipped += p.zip.length;
    unzipped += p.unzipped;
  }
  checkSize(zipped, unzipped, limits);
}

/**
 * Store a push's modules as Convex's package (`buildPackage`); the package's row (its key, hash and sizes, and the
 * push's Node version, as Convex's `upload_package`).
 */
export async function writePackage(
  store: BlobStore,
  modules: ModuleSource[],
  limits?: { zipped: number; unzipped: number },
  nodeVersion: string | null = null,
  external: PackageExternalDeps | null = null,
): Promise<SourcePackageFields> {
  const { zip, unzipped } = buildPackage(modules, limits, external);
  const written = await store.put(zip);
  return {
    storageKey: written.key,
    sha256: written.sha256.slice().buffer,
    externalPackageId: external?.id ?? null,
    packageSize: { zippedSizeBytes: BigInt(written.size), unzippedSizeBytes: BigInt(unzipped) },
    nodeVersion,
  };
}

/**
 * A package's modules (Convex's `download_package`): every `modules/<path>.js` with its `.map`, each module's
 * environment from `metadata.json`, whose paths must be the archive's.
 */
export async function readPackage(store: BlobStore, storageKey: string): Promise<ModuleSource[]> {
  const stream = await store.get(storageKey);
  if (!stream) throw new Error(`the code package ${storageKey} is missing from the modules store`);
  const archive = new Uint8Array(await new Response(stream).arrayBuffer());
  const zip = await ZipReader.open(bytesSource(archive));
  const dec = new TextDecoder();
  const sources = new Map<string, string>();
  const maps = new Map<string, string>();
  let metadata: PackageMetadata | null = null;
  for (const entry of zip.entries) {
    const text = dec.decode(entryBytes(archive, entry));
    if (entry.name === "metadata.json") {
      metadata = JSON.parse(text) as PackageMetadata;
      continue;
    }
    if (!entry.name.startsWith("modules/")) throw new Error(`a package entry outside modules/: ${entry.name}`);
    const path = entry.name.slice("modules/".length);
    if (path.endsWith(".js")) sources.set(path, text);
    else if (path.endsWith(".js.map")) maps.set(path.slice(0, -".map".length), text);
    else throw new Error(`a package entry that is not a module: ${entry.name}`);
  }
  if (!metadata) throw new Error("the package has no metadata.json");
  const found = [...sources.keys(), ...[...maps.keys()].map((p) => `${p}.map`)].sort();
  if (JSON.stringify([...metadata.modulePaths].sort()) !== JSON.stringify(found))
    throw new Error("the package's metadata.json paths are not its modules");
  const environments = new Map(metadata.moduleEnvironments ?? []);
  return [...sources].map(([path, source]) => {
    const environment = environments.get(path) ?? (path.startsWith("actions/") ? "node" : "isolate");
    const map = maps.get(path);
    return { path, source, ...(map === undefined ? {} : { sourceMap: map }), environment };
  });
}

/**
 * The deployed package's modules, or null when bunvex cannot read it (a damaged blob, or a package in
 * another format, such as the gzip JSON earlier bunvex versions wrote): it is ignored with a log line, as if nothing were deployed, and the
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
    // The row is Convex's `SerializedAnalyzedModule`, which has no rooms: a reloaded version analyzes them again.
    rooms: [],
  };
}

/** A module that defines no function (the schema, the auth config): Convex analyzes it to nothing. */
const NOTHING: AnalyzedModule = { functions: [], httpRoutes: null, cronSpecs: null, rooms: [] };

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
 * The root component's rows for a deploy that is not a push (`deployCode`: the dev loop, tests), as a push leaves
 * them in Convex with no components (STUDY-133 §12 M2): the default app definition in `_component_definitions` and
 * its instance in `_components`, written once. A push writes them from the evaluated tree (STUDY-153 PR 4).
 */
export async function ensureRootComponent(db: Tx) {
  await db.asSystem(async () => {
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
  /** The component whose code it is (its `_components` id), or null for the app's (STUDY-153 PR 4). */
  namespace: string | null = null,
): Promise<SourcePackage[]> {
  return db.asSystem(() =>
    db.inComponent(namespace, async () => {
      const sourcePackageId = await db.insert(SOURCE_PACKAGES_TABLE, pkg);
      const old = (await db.query(MODULES_TABLE).collect()) as unknown as ModuleRow[];
      const byPath = new Map(old.map((m) => [m.path, m]));
      const modules = [
        ...[...version.modules].map(([path, l]) => ({
          path,
          source: l.source,
          hash: l.hash,
          a: version.analysis[path],
        })),
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
      const unused: SourcePackage[] = [];
      for (const p of (await db.query(SOURCE_PACKAGES_TABLE).collect()) as unknown as SourcePackage[])
        if (p._id !== sourcePackageId) {
          await db.delete(SOURCE_PACKAGES_TABLE, p._id);
          unused.push(p);
        }
      return unused;
    }),
  ) as Promise<SourcePackage[]>;
}

/** A component's module paths as stored (its `_modules` rows), in its namespace. */
export async function modulePathsIn(db: Tx, namespace: string | null): Promise<string[]> {
  return db.asSystem(() =>
    db.inComponent(namespace, async () => (await db.query(MODULES_TABLE).collect()).map((r) => r.path as string)),
  );
}

/**
 * An unmounted component's code (Convex's `unmount_component`): its `_modules` rows deleted; its `_source_packages`
 * and `_udf_config`, its schema and tables kept. The paths it had.
 */
export async function clearCodeRows(db: Tx, namespace: string): Promise<string[]> {
  return db.asSystem(() =>
    db.inComponent(namespace, async () => {
      const rows = await db.query(MODULES_TABLE).collect();
      for (const r of rows) await db.delete(MODULES_TABLE, r._id as string);
      return rows.map((r) => r.path as string);
    }),
  );
}

/**
 * A component's `_udf_config` (Convex's `UdfConfigModel::set` in its namespace): its definition's server version,
 * with the app's import seed and time. The version's change, from "Unspecified version" when it had none; null when
 * it is the same.
 */
export async function setUdfConfigIn(
  db: Tx,
  namespace: string,
  config: UdfConfig,
): Promise<UdfServerVersionDiff | null> {
  return db.asSystem(() =>
    db.inComponent(namespace, async () => {
      const row = (await db.query(UDF_CONFIG_TABLE).first()) as Record<string, unknown> | null;
      if (row && row.serverVersion === config.serverVersion) return null;
      const fields = {
        serverVersion: config.serverVersion,
        importPhaseRngSeed: config.seed.buffer.slice(0),
        importPhaseUnixTimestamp: nsOfMs(config.timestamp),
      };
      if (row) await db.replace(UDF_CONFIG_TABLE, row._id as string, fields);
      else await db.insert(UDF_CONFIG_TABLE, fields);
      return {
        previous_version: row ? (row.serverVersion as string) : "Unspecified version",
        next_version: config.serverVersion,
      };
    }),
  );
}

/** Every package's blob some namespace's `_source_packages` row still names (two instances share one). */
export async function referencedPackageKeys(db: Tx, namespaces: Iterable<string | null>): Promise<Set<string>> {
  const keys = new Set<string>();
  for (const ns of namespaces)
    for (const p of await db.asSystem(() => db.inComponent(ns, () => db.query(SOURCE_PACKAGES_TABLE).collect())))
      keys.add(p.storageKey as string);
  return keys;
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
  // The push's external packages (STUDY-148), extracted for this process from the modules store.
  let nodeModules: string | undefined;
  if (stored.pkg.externalPackageId) {
    const row = await externalDepsRow(engine, stored.pkg.externalPackageId);
    if (!row) throw new Error(`the external packages ${stored.pkg.externalPackageId} of the deployed code are missing`);
    nodeModules = await externalDepsPath(store, row);
  }
  const version = await CodeVersion.load(
    sources.filter((m) => m.path !== AUTH_CONFIG_MODULE && m.path !== SCHEMA_MODULE && isFunctionModule(m.path)),
    { seed: config.seed, timestamp: config.timestamp, env, ...(nodeModules ? { nodeModules } : {}) },
  );
  return { version, authConfig: sources.find((m) => m.path === AUTH_CONFIG_MODULE) ?? null };
}

/**
 * Whether a stored module defines functions: not one whose name has more than one dot, as Convex's entry-point rule
 * (`auth.config.js`, and the component definition a Convex push stores beside the functions, STUDY-153 C-2, which
 * imports its children from `_componentDeps/` and is no function module).
 */
const isFunctionModule = (path: string) => !/\.[^/]*\./.test(path.slice(path.lastIndexOf("/") + 1));

/** The latest deployed version, loaded, or null. */
export async function loadLatestCodeVersion(
  engine: Engine,
  store: BlobStore,
  env: Record<string, string> = {},
): Promise<CodeVersion | null> {
  return (await loadLatestCode(engine, store, env))?.version ?? null;
}

export { moduleName };
