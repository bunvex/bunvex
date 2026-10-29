// `node.externalPackages` on the CLI's side (STUDY-148), as Convex's `bundler/external.ts`: which packages the
// `"use node"` bundle leaves as imports for the deployment to install, and their exact installed versions.
//
// - The candidates are the project's `package.json` dependencies (all four kinds, the first occurrence of a name
//   winning) that the list names, or all of them under `"*"`; never `bunvex`, `bunvex/*` or `@bunvex/*` (linked to
//   the server's own modules or bundled, as Convex always bundles `convex`), nor a local, URL or git version; and only if the
//   project's top-level `node_modules` has them.
// - The plugin leaves an import external only when it resolves to that top-level copy (a nested copy is bundled).
// - The versions are the installed ones (its `package.json`), with the peer and optional dependencies that are also
//   candidates, transitively.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { BunPlugin } from "bun";
import { BundleError } from "./bundle.ts";

/** A package the push asks the deployment to install (Convex's `NodeDependency`). */
export type NodeDependency = { name: string; version: string };

/** Candidates by name: where the project's top-level copy is. */
export type ExternalPackages = Map<string, { path: string }>;

/** A package's name (`@scope/name` or the first segment) and its directory under `node_modules`. */
export function packageOf(importPath: string): { name: string; dir: string } {
  const parts = importPath.split("/");
  if (importPath.startsWith("@")) return { name: `${parts[0]}/${parts[1]}`, dir: join(parts[0]!, parts[1] ?? "") };
  return { name: parts[0]!, dir: parts[0]! };
}

/** The packages linked to the server's own modules: never installed. */
const isBunvex = (name: string) => name.startsWith("@bunvex/");

/** Convex's `shouldMarkExternal`: whether a dependency of `package.json` may be left external. */
export function shouldMarkExternal(name: string, version: string, allowList: string[]): boolean {
  if (isBunvex(name)) return false;
  // Local packages are bundled; so are URL and git ones ("installing those might or might not work").
  if (/^(file:|git\+file:\/\/|https?:\/\/|git:\/\/|git\+ssh:\/\/|git\+https?:\/\/)/.test(version)) return false;
  return allowList.includes(name) || allowList.includes("*");
}

/** The first `package.json` from `cwd` up (Convex's `findParentConfigs`). */
function findPackageJson(cwd: string): string {
  let dir = resolve(cwd);
  for (;;) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new BundleError("No package.json found.");
    dir = parent;
  }
}

/** Convex's `computeExternalPackages`: the candidates, from the project's `package.json`. */
export function computeExternalPackages(cwd: string, allowList: string[]): ExternalPackages {
  const out: ExternalPackages = new Map();
  if (!allowList.length) return out;
  const packageJsonPath = findPackageJson(cwd);
  let packageJson: Record<string, unknown>;
  try {
    packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  } catch (e) {
    throw new BundleError(`Couldn't parse "${packageJsonPath}". Make sure it's a valid JSON. Error: ${e}`);
  }
  for (const key of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    for (const [name, version] of Object.entries((packageJson[key] ?? {}) as Record<string, unknown>)) {
      if (out.has(name)) continue;
      if (typeof version !== "string")
        throw new BundleError(`Invalid "${packageJsonPath}". "${key}.${name}" version has type ${typeof version}.`);
      if (!shouldMarkExternal(name, version, allowList)) continue;
      const path = join(dirname(packageJsonPath), "node_modules", packageOf(name).dir);
      if (existsSync(path)) out.set(name, { path });
    }
  }
  return out;
}

/** Node's lookup of `node_modules/<dir>` from `from` up: the first that exists (Convex's `resolveNodeModule`). */
function resolveNodeModule(dir: string, from: string): string | null {
  let at = resolve(from);
  for (;;) {
    const candidate = join(at, "node_modules", dir);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(at);
    if (parent === at) return null;
    at = parent;
  }
}

/**
 * Convex's `convex-node-externals` plugin: an import of a candidate that resolves to its top-level copy stays an
 * import (as written, subpath included); the name is recorded in `used`.
 */
export function externalPlugin(packages: ExternalPackages, used: Set<string>): BunPlugin {
  return {
    name: "bunvex-node-externals",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (args.path.startsWith(".") || args.path.startsWith("/") || !args.resolveDir) return undefined;
        const { name, dir } = packageOf(args.path);
        const candidate = packages.get(name);
        const found = candidate && resolveNodeModule(dir, args.resolveDir);
        // Real paths on both sides: Bun gives the importer's real directory (macOS's /var is /private/var).
        if (candidate && found && realpathSync(found) === realpathSync(candidate.path)) {
          used.add(name);
          return { path: args.path, external: true };
        }
        return undefined;
      });
    },
  };
}

/** The installed version of a candidate and its peer and optional dependencies (Convex's
 *  `findExactVersionAndDependencies`). */
function installedPackage(name: string, path: string): { version: string; peersAndOptionals: string[] } {
  const packageJsonPath = join(path, "package.json");
  let packageJson: Record<string, unknown>;
  try {
    packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  } catch {
    throw new BundleError(
      `Missing "${packageJsonPath}", which is required for installing external package "${name}" configured in bunvex.json.`,
    );
  }
  if (packageJson.version === undefined)
    throw new BundleError(
      `"${packageJsonPath}" misses a 'version' field. which is required for installing external package "${name}" configured in bunvex.json.`,
    );
  const peersAndOptionals: string[] = [];
  for (const key of ["peerDependencies", "optionalDependencies"])
    for (const [dep, version] of Object.entries((packageJson[key] ?? {}) as Record<string, unknown>)) {
      if (typeof version !== "string")
        throw new BundleError(`Invalid "${packageJsonPath}". "${key}.${dep}" version has type ${typeof version}.`);
      peersAndOptionals.push(dep);
    }
  return { version: String(packageJson.version), peersAndOptionals };
}

/**
 * Convex's `externalPackageVersions`: the packages the bundle left external, each at its installed version, then
 * the peer and optional dependencies of each that are candidates too.
 */
export function externalPackageVersions(packages: ExternalPackages, used: Set<string>): NodeDependency[] {
  const queue = [...used];
  const seen = new Set(used);
  const out: NodeDependency[] = [];
  for (let i = 0; i < queue.length; i++) {
    const name = queue[i]!;
    const { version, peersAndOptionals } = installedPackage(name, packages.get(name)!.path);
    out.push({ name, version });
    for (const dep of peersAndOptionals)
      if (packages.has(dep) && !seen.has(dep)) {
        seen.add(dep);
        queue.push(dep);
      }
  }
  return out;
}
