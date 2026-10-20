// The packages a push asks the deployment to install for its `"use node"` modules (STUDY-148), as Convex's
// `build_external_node_deps` (crates/application/src/lib.rs) and its Node executor's `build_deps` /
// `source_package.ts`:
//
// - A push's `nodeDependencies` (`[{name, version}]`, exact versions) reuse one of the 10 newest
//   `_external_deps_packages` rows with the same packages and versions, or are installed: a `package.json` of them
//   in a fresh directory, `bun install` with the server's Bun and environment (its registry settings apply), then
//   `bun pm trust --all`, so every dependency's install scripts run as npm runs them (DV-470, DV-471).
// - `node_modules` is zipped as Convex's archive (`node_modules/…` entries, directories included, Unix modes kept),
//   put in the modules store, and recorded as Convex's row: `{storageKey, sha256, deps: [{package, version}],
//   packageSize: {zippedSizeBytes, unzippedSizeBytes}}`. Rows and blobs are never deleted (as Convex's).
// - Node modules resolve packages from a per-process directory, `<tmpdir>/bunvex-node-<random>/<storage key>/
//   node_modules`: moved there right after an install, else extracted from the blob (its sha256 checked, every entry
//   under `node_modules/`, modes and symlinks restored, DV-473). The directory goes when the process exits.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readdirSync, readlinkSync, rmSync, statSync } from "node:fs";
import { chmod, mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { type Engine, EXTERNAL_DEPS_PACKAGES_TABLE } from "@bunvex/core";
import type { BlobStore } from "@bunvex/file-storage";
import { NODE_ACTION_USER_TIMEOUT_MS } from "./action-timeout.ts";
import { type RangeSource, ZipReader } from "./zip-reader.ts";
import { ZipFileWriter } from "./zip-writer.ts";

/** A package as a push names it (Convex's `NodeDependencyJson`). */
export type NodeDependency = { name: string; version: string };

/** An `_external_deps_packages` row (Convex's `SerializedExternalDepsPackage`). */
export type ExternalDepsPackage = {
  _id: string;
  storageKey: string;
  sha256: ArrayBuffer;
  deps: { package: string; version: string }[];
  packageSize: { zippedSizeBytes: bigint; unzippedSizeBytes: bigint };
};

/** Convex's `NUM_EXTERNAL_DEPS_CACHE_ENTRIES`: how many of the newest rows an install may reuse. */
export const CACHE_ENTRIES = 10;

/** An install that failed: Convex's 400 `InvalidExternalModules`, with the installer's output. */
export class ExternalDepsError extends Error {
  readonly code = "InvalidExternalModules";
}

/** The deps as a map from package to version, canonical (Convex compares `BTreeMap`s). */
const depsKey = (deps: { package: string; version: string }[]) =>
  JSON.stringify(
    [...new Map(deps.map((d) => [d.package, d.version]))].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );

/** Convex's `get_cached_package_match`: the newest of the last `CACHE_ENTRIES` rows with the same packages. */
export async function cachedExternalDeps(engine: Engine, deps: NodeDependency[]): Promise<ExternalDepsPackage | null> {
  const want = depsKey(deps.map((d) => ({ package: d.name, version: d.version })));
  const rows = (await engine.query((db) =>
    db.asSystem(() => db.query(EXTERNAL_DEPS_PACKAGES_TABLE).order("desc").take(CACHE_ENTRIES)),
  )) as unknown as ExternalDepsPackage[];
  return rows.find((r) => depsKey(r.deps) === want) ?? null;
}

/** The row with this id (a package's `externalPackageId`), or null. */
export async function externalDepsRow(engine: Engine, id: string): Promise<ExternalDepsPackage | null> {
  return (await engine.query((db) =>
    db.asSystem(() => db.get(EXTERNAL_DEPS_PACKAGES_TABLE, id)),
  )) as unknown as ExternalDepsPackage | null;
}

let processRoot: string | null = null;
/** This process's directory of extracted packages (Convex's executor's temporary directory), made on first use. */
function root(): string {
  if (!processRoot) {
    const made = mkdtempSync(join(tmpdir(), "bunvex-node-"));
    processRoot = made;
    process.once("exit", () => rmSync(made, { recursive: true, force: true }));
  }
  return processRoot;
}

/** The directory a package's `node_modules` is in, for this process. */
const depsDir = (storageKey: string) => join(root(), storageKey);

/**
 * How long an install may take: Convex's `build_deps` is a request to its Node executor, which times out after
 * NODE_ACTION_USER_TIMEOUT (600 s) + 5 s (crates/local_backend/src/lib.rs:206, node_executor/src/local.rs:285).
 */
export const BUILD_DEPS_TIMEOUT_MS = NODE_ACTION_USER_TIMEOUT_MS + 5000;

/** Convex's `EXECUTE_TIMEOUT_RESPONSE_JSON` message, what a timed-out build fails with. */
export const BUILD_DEPS_TIMED_OUT =
  "Function execution unexpectedly timed out. Check your function for infinite loops or other long-running operations.";

/** Run a Bun command; its output (stdout then stderr) and exit code. Killed once `deadline` passes. */
async function bun(args: string[], cwd: string, env: Record<string, string | undefined>, deadline: number) {
  const left = deadline - performance.now();
  if (left <= 0) throw new ExternalDepsError(BUILD_DEPS_TIMED_OUT);
  // The server's own Bun; `BUN_BE_BUN` makes a compiled server binary act as Bun's CLI.
  const p = Bun.spawn([process.execPath, ...args], {
    cwd,
    env: { ...env, BUN_BE_BUN: "1" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: Math.ceil(left),
    killSignal: "SIGKILL",
  });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  if (p.signalCode === "SIGKILL" && performance.now() >= deadline) throw new ExternalDepsError(BUILD_DEPS_TIMED_OUT);
  return { code, out, err };
}

/** `node_modules`' entries, sorted, each with its Unix mode; the sum of its files' sizes (Convex's `dirSize`). */
function walk(dir: string): { entries: { path: string; mode: number; link?: string }[]; unzipped: number } {
  const entries: { path: string; mode: number; link?: string }[] = [];
  let unzipped = 0;
  const visit = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) {
        entries.push({ path: full, mode: st.mode, link: readlinkSync(full) });
        const target = statSync(full, { throwIfNoEntry: false });
        if (target?.isFile()) unzipped += target.size;
      } else if (st.isDirectory()) {
        entries.push({ path: full, mode: st.mode });
        visit(full);
      } else if (st.isFile()) {
        entries.push({ path: full, mode: st.mode });
        unzipped += st.size;
      }
    }
  };
  visit(dir);
  return { entries, unzipped };
}

/**
 * Install `deps` and record them (Convex's `build_deps`, then `_upload_external_deps_package`): the row, and the
 * packages ready in this process's directory. A failed install throws `ExternalDepsError`.
 */
export async function buildExternalDeps(
  engine: Engine,
  store: BlobStore,
  deps: NodeDependency[],
  env: Record<string, string | undefined> = process.env,
  /** `timeoutMs`: how long the install may take (STUDY-174 S6), `BUILD_DEPS_TIMEOUT_MS` by default. */
  { timeoutMs = BUILD_DEPS_TIMEOUT_MS }: { timeoutMs?: number } = {},
): Promise<ExternalDepsPackage> {
  const deadline = performance.now() + timeoutMs;
  const build = mkdtempSync(join(tmpdir(), "bunvex-build-deps-"));
  try {
    const dependencies = Object.fromEntries(deps.map((d) => [d.name, d.version]));
    await writeFile(
      join(build, "package.json"),
      JSON.stringify({ name: "bunvex-external-deps", version: "0.0.0", private: true, dependencies }),
    );
    const install = await bun(["install"], build, env, deadline);
    if (install.code !== 0)
      throw new ExternalDepsError(`Command failed: bun install\n${`${install.out}${install.err}`.trim()}`);
    // npm runs every dependency's install scripts; Bun only its trusted ones, so the rest run now (DV-471). With
    // none left it says so and exits 1.
    const trust = await bun(["pm", "trust", "--all"], build, env, deadline);
    if (trust.code !== 0 && !/\b0 scripts ran\b/.test(trust.err + trust.out))
      throw new ExternalDepsError(`Command failed: bun pm trust --all\n${`${trust.out}${trust.err}`.trim()}`);
    const nodeModules = join(build, "node_modules");
    if (!existsSync(nodeModules)) throw new ExternalDepsError("Failed to generate node_modules");
    const { entries, unzipped } = walk(nodeModules);
    const zipPath = join(build, "node_modules.zip");
    const zip = new ZipFileWriter(zipPath);
    try {
      for (const e of entries) {
        const name = relative(build, e.path).split(sep).join("/");
        if (e.link !== undefined) await zip.add(name, e.link, e.mode);
        else if ((e.mode & 0o170000) === 0o040000) await zip.add(`${name}/`, new Uint8Array(), e.mode);
        else await zip.add(name, Bun.file(e.path).stream() as unknown as AsyncIterable<Uint8Array>, e.mode);
      }
      await zip.finish();
    } catch (e) {
      await zip.discard();
      throw e;
    }
    const written = await store.put(Bun.file(zipPath));
    const fields = {
      storageKey: written.key,
      sha256: written.sha256.slice().buffer,
      deps: deps.map((d) => ({ package: d.name, version: d.version })),
      packageSize: { zippedSizeBytes: BigInt(written.size), unzippedSizeBytes: BigInt(unzipped) },
    };
    let id: string;
    try {
      id = (await engine.mutation(
        (db) => db.asSystem(() => db.insert(EXTERNAL_DEPS_PACKAGES_TABLE, fields as never)),
        "_system/push",
      )) as string;
    } catch (e) {
      await store.delete(written.key).catch(() => {});
      throw e;
    }
    // What was just installed is what the blob holds: no need to extract it again in this process.
    const dir = depsDir(written.key);
    await mkdir(dir, { recursive: true });
    await rename(nodeModules, join(dir, "node_modules"));
    ready.set(written.key, Promise.resolve(dir));
    return { _id: id, ...fields };
  } finally {
    await rm(build, { recursive: true, force: true });
  }
}

/** A reader's source over a file on disk. */
const fileSource = (path: string): RangeSource => {
  const file = Bun.file(path);
  return {
    size: file.size,
    read: async (start, end) => new Uint8Array(await file.slice(start, end + 1).arrayBuffer()),
    stream: async (start, end) => file.slice(start, end + 1).stream(),
  };
};

/** The packages being or already extracted in this process, by storage key. */
const ready = new Map<string, Promise<string>>();

/**
 * The directory whose `node_modules` holds a row's packages, in this process: extracted from the modules store
 * the first time (Convex's `downloadExternalPackage`).
 */
export function externalDepsPath(store: BlobStore, row: ExternalDepsPackage): Promise<string> {
  let p = ready.get(row.storageKey);
  if (!p) {
    p = extract(store, row);
    ready.set(row.storageKey, p);
    p.catch(() => ready.delete(row.storageKey));
  }
  return p;
}

async function extract(store: BlobStore, row: ExternalDepsPackage): Promise<string> {
  const dir = depsDir(row.storageKey);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const download = join(dir, "node_modules.zip");
  const stream = await store.get(row.storageKey);
  if (!stream) throw new Error(`the external packages ${row.storageKey} are missing from the modules store`);
  const hash = createHash("sha256");
  const writer = Bun.file(download).writer();
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    hash.update(chunk);
    writer.write(chunk);
  }
  await writer.end();
  if (!Buffer.from(row.sha256).equals(hash.digest()))
    throw new Error(`the external packages ${row.storageKey} do not match their sha256`);
  const zip = await ZipReader.open(fileSource(download));
  for (const entry of zip.entries) {
    // Convex's executor refuses anything outside `node_modules/`; a path may not climb out either.
    if (!entry.name.startsWith("node_modules/") || entry.name.split("/").includes(".."))
      throw new Error(`found incorrect package entry ${entry.name}`);
    const to = join(dir, entry.name);
    await mkdir(dirname(to), { recursive: true });
    const chunks: Uint8Array[] = [];
    for await (const c of zip.read(entry)) chunks.push(c);
    const bytes = Buffer.concat(chunks);
    if ((entry.mode & 0o170000) === 0o120000) await symlink(bytes.toString("utf8"), to);
    else {
      await writeFile(to, bytes);
      if (entry.mode & 0o777) await chmod(to, entry.mode & 0o777);
    }
  }
  await rm(download, { force: true });
  return dir;
}
