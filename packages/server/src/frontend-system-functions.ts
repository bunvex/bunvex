// The Functions screen's and the Settings screens' reads (STUDY-149 PR 4), as Convex's
// npm-packages/system-udfs/convex/_system/frontend: the deployed modules and their analyzed functions
// (`modules.ts`), the components (`components.ts`), the version the app was pushed with (`getVersion.ts`), the
// deployment's URLs (`convexCloudUrl.ts`, `convexSiteUrl.ts`, renamed by rule 5: DV-474), the environment
// variables (`listEnvironmentVariables.ts`), the latest snapshot export (`latestExport.ts`) and the snapshot
// imports (`snapshotImport.ts`). Same names (but the two URLs), arguments, permissions and result shapes; the
// rows they read are Convex's (`_modules`, `_components`, `_udf_config`, STUDY-134). `componentId` is accepted and
// ignored, as bunvex has only the root component (DV-55).
import {
  ENVIRONMENT_VARIABLES_TABLE,
  EXPORTS_TABLE,
  MODULES_TABLE,
  SNAPSHOT_IMPORTS_TABLE,
  type Tx,
  UDF_CONFIG_TABLE,
} from "@bunvex/core";
import { v } from "@bunvex/values";
import { readCanonicalUrls } from "./canonical-urls.ts";
import type { SystemQuery } from "./system-functions.ts";

/** Convex's `_components` (core keeps its name unexported; code-store.ts writes the root's row). */
const COMPONENTS_TABLE = "_components";
const componentId = v.optional(v.union(v.string(), v.null()));

/** What `exportArgs()` gives a function declared without arguments (Convex's `DEFAULT_ARGS_VALIDATOR`). */
const DEFAULT_ARGS_VALIDATOR = '{ "type": "any" }';

type Position = { start_lineno: bigint } | null;
type ModuleDoc = {
  path: string;
  sourcePackageId: string;
  analyzeResult: {
    functions: { name: string; pos: Position; udfType: string; visibility: { kind: string } | null; args?: string }[];
    httpRoutes: { route: { path: string; method: string }; pos: Position }[] | null;
    cronSpecs: { identifier: string; spec: unknown }[] | null;
  } | null;
};

/** Convex's `processFunction` / `processHttpRoute`: a function's line (from its position) when it is known. */
const lineOf = (pos: Position) => (pos?.start_lineno ? Number(pos.start_lineno) : undefined);

/**
 * Convex's `listHandler`: each module with an analysis, in the table's order, as `[path, {functions,
 * sourcePackageId, cronSpecs?}]`; its HTTP routes are functions named `<METHOD> <path>` (the dashboard's form).
 * `sourcePackageId` changes with every push, so a subscription to it re-runs on one.
 */
async function listModules(db: Tx) {
  const rows = (await db.asSystem(() => db.query(MODULES_TABLE).collect())) as unknown as ModuleDoc[];
  const out: [string, Record<string, unknown>][] = [];
  for (const m of rows) {
    const a = m.analyzeResult;
    if (!a) continue;
    const functions: Record<string, unknown>[] = a.functions.map((f) => ({
      name: f.name,
      lineno: lineOf(f.pos),
      udfType: f.udfType,
      visibility: f.visibility ?? { kind: "public" },
    }));
    for (const r of a.httpRoutes ?? [])
      functions.push({
        name: `${r.route.method} ${r.route.path}`,
        lineno: lineOf(r.pos),
        udfType: "HttpAction",
        visibility: { kind: "public" },
      });
    out.push([
      m.path,
      {
        functions,
        sourcePackageId: m.sourcePackageId,
        ...(a.cronSpecs !== null && { cronSpecs: a.cronSpecs.map((c) => [c.identifier, c.spec]) }),
      },
    ]);
  }
  return out;
}

type ComponentDoc = {
  _id: string;
  parent: string | null;
  name?: string | null;
  args?: [string, unknown][] | null;
  state?: string;
  httpPrefix?: string | null;
};

export const FRONTEND_SYSTEM_QUERIES: Record<string, SystemQuery> = {
  // Convex's `modules:listForAllComponents`: the root's modules, then each child component's (none in bunvex,
  // DV-55), as `[componentId | null, [path, module][]]`.
  "_system/frontend/modules:listForAllComponents": {
    args: {},
    handler: async (db) => {
      const result: [string | null, unknown][] = [[null, await listModules(db)]];
      // read as Convex's, which recurses into each child; bunvex writes the root's row only
      await db.asSystem(() => db.query(COMPONENTS_TABLE).collect());
      return result;
    },
  },
  // Convex's `modules:list`: one component's modules.
  "_system/frontend/modules:list": {
    args: { componentId },
    handler: (db) => listModules(db),
  },
  // Convex's `modules:argsValidator`: a function's arguments validator, by its display name (`dir/file:name`), as
  // the JSON text the push stored; null when the module, its analysis or the function is not there.
  "_system/frontend/modules:argsValidator": {
    args: { componentId, function: v.string() },
    handler: async (db, { function: fn }: { function: string }) => {
      // Convex's `split(":")`: the first two parts, the name `default` when there is none
      const [path, name] = fn.split(":");
      const module = (await db.asSystem(() =>
        db
          .query(MODULES_TABLE)
          .withIndex("by_path", (q) => q.eq("path", `${path}.js`))
          .unique(),
      )) as unknown as ModuleDoc | null;
      const found = module?.analyzeResult?.functions.find((f) => f.name === (name ?? "default"));
      if (!found) return null;
      return found.args ?? DEFAULT_ARGS_VALIDATOR;
    },
  },
  // Convex's `components:list`: every component with its path (the root's is ""), arguments, state and HTTP
  // prefix.
  "_system/frontend/components:list": {
    args: {},
    handler: async (db) => {
      const docs = (await db.asSystem(() => db.query(COMPONENTS_TABLE).collect())) as unknown as ComponentDoc[];
      const byId = new Map(docs.map((d) => [d._id, d]));
      const paths = new Map<string, string>();
      const pathOf = (d: ComponentDoc): string => {
        const known = paths.get(d._id);
        if (known !== undefined) return known;
        const parent = d.parent ? byId.get(d.parent) : undefined;
        const parentPath = parent ? pathOf(parent) : "";
        const path = !d.parent ? "" : parentPath === "" ? (d.name ?? "") : `${parentPath}/${d.name ?? ""}`;
        paths.set(d._id, path);
        return path;
      };
      return docs.map((d) => ({
        id: d._id,
        name: d.name,
        path: pathOf(d),
        args: Object.fromEntries(d.args ?? []),
        state: d.state ?? "active",
        httpPrefix: d.httpPrefix ?? null,
      }));
    },
  },
  // Convex's `getVersion`: the client version the app was last pushed with (`_udf_config.serverVersion`), or null.
  "_system/frontend/getVersion": {
    args: {},
    noPermissionRequired: true,
    handler: async (db) => {
      const row = (await db.asSystem(() => db.query(UDF_CONFIG_TABLE).order("desc").unique())) as {
        serverVersion?: string;
      } | null;
      return row?.serverVersion || null;
    },
  },
  // Convex's `convexCloudUrl` (DV-474: renamed by rule 5), the same as `_system/cli/deploymentUrl:cloudUrl`: the
  // deployment's `BUNVEX_CLOUD_URL`.
  "_system/frontend/cloudUrl": {
    args: {},
    handler: async (db, _args, env) =>
      (await readCanonicalUrls(db)).cloud ?? env.functions?.builtinEnv.BUNVEX_CLOUD_URL ?? null,
  },
  // Convex's `convexSiteUrl` (DV-474): the deployment's `BUNVEX_SITE_URL`, where its HTTP actions answer.
  "_system/frontend/siteUrl": {
    args: {},
    handler: async (db, _args, env) =>
      (await readCanonicalUrls(db)).site ?? env.functions?.builtinEnv.BUNVEX_SITE_URL ?? null,
  },
  // Convex's `listEnvironmentVariables`: every `_environment_variables` document, by name.
  "_system/frontend/listEnvironmentVariables": {
    args: {},
    op: "ViewEnvironmentVariables",
    handler: (db) =>
      db.asSystem(() => db.query(ENVIRONMENT_VARIABLES_TABLE).withIndex("by_name").order("asc").collect()),
  },
  // Convex's `latestExport`: the newest snapshot export, or null.
  "_system/frontend/latestExport": {
    args: {},
    op: "ViewBackups",
    handler: (db) =>
      db.asSystem(() =>
        db
          .query(EXPORTS_TABLE)
          .withIndex("by_requestor", (q) => q.eq("requestor", "snapshotExport"))
          .order("desc")
          .first(),
      ),
  },
  // Convex's `snapshotImport:list`: the 20 newest imports, newest first.
  "_system/frontend/snapshotImport:list": {
    args: {},
    op: "ViewBackups",
    handler: async (db) =>
      db.asSystem(async () =>
        ((await db.query(SNAPSHOT_IMPORTS_TABLE).order("desc").take(20)) as Record<string, unknown>[]).map(
          ({ object_size: _, hidden_tables: __, ...rest }) => rest,
        ),
      ),
  },
};
