// Where deployed code lives (STUDY-35), as Convex keeps it:
//   `_source_packages` — one row per pushed package, pointing at its blob in the modules store (Convex: a zip
//     in module storage; here one gzip-compressed JSON blob, DV-166; Convex's zip is read too);
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
  // A store Convex deployed to holds Convex's zip (STUDY-133 §12 M10): read it too, so a push over it can
  // take its unchanged modules. bunvex still writes its own package (DV-166).
  if (isZip(bytes)) return readZipPackage(bytes);
  return (JSON.parse(new TextDecoder().decode(Bun.gunzipSync(bytes))) as { modules: ModuleSource[] }).modules;
}

const isZip = (b: Uint8Array) => b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;

/** A zip archive's entries, by name, from its central directory (stored or deflated entries). */
export function unzip(bytes: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The end of central directory record: its signature within the last 64 KiB + 22 bytes (the comment's room).
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--)
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  if (eocd < 0) throw new Error("not a zip archive: no end of central directory");
  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  const out = new Map<string, Uint8Array>();
  const decoder = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error("a zip central directory entry is corrupt");
    const method = view.getUint16(at + 10, true);
    const compressed = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    // The data follows the local header, whose name and extra field lengths may differ from the central one's.
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = bytes.subarray(start, start + compressed);
    if (method === 0) out.set(name, data);
    else if (method === 8) out.set(name, Bun.inflateSync(data));
    else throw new Error(`zip entry ${name}: compression method ${method} is not supported`);
    at += 46 + nameLength + extraLength + commentLength;
  }
  return out;
}

/**
 * Convex's code package (crates/model/src/source_packages/upload_download.rs): `modules/<path>` and
 * `modules/<path>.map` entries, and a `metadata.json` with each module's environment.
 */
function readZipPackage(bytes: Uint8Array): ModuleSource[] {
  const entries = unzip(bytes);
  const text = (b: Uint8Array) => new TextDecoder().decode(b);
  const metadata = entries.get("metadata.json");
  if (!metadata) throw new Error("the code package has no metadata.json");
  const meta = JSON.parse(text(metadata)) as { moduleEnvironments?: [string, "isolate" | "node"][] | null };
  const environments = new Map(meta.moduleEnvironments ?? []);
  const out: ModuleSource[] = [];
  for (const [name, data] of entries) {
    if (!name.startsWith("modules/") || !name.endsWith(".js")) continue;
    const path = name.slice("modules/".length);
    const map = entries.get(`${name}.map`);
    out.push({
      path,
      source: text(data),
      ...(map ? { sourceMap: text(map) } : {}),
      environment: environments.get(path) ?? (path.startsWith("actions/") ? "node" : "isolate"),
    });
  }
  return out;
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
  const sources = await readPackage(store, stored.pkg.storageKey);
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
