// `bunvex deploy` (STUDY-35): bundle the functions directory and push it to a self-hosted deployment over
// Convex's deploy2 protocol — get_config_hashes, start_push, wait_for_schema, finish_push.
//
// Where (owner decisions, 2026-10-02): the functions directory is `bunvex/` unless `bunvex.json` says
// `{ "functions": "…" }`; the deployment is `--url` / `--admin-key`, else BUNVEX_SELF_HOSTED_URL /
// BUNVEX_SELF_HOSTED_ADMIN_KEY, read from the environment, then `.env.local`, then `.env` (as Convex's CLI
// reads CONVEX_SELF_HOSTED_*).
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { BundleError, bundleFunctions, type ModuleConfig } from "./bundle.ts";
import { type CodegenConfig, runCodegen, type TypecheckMode, typecheck } from "./codegen.ts";
import type { Io } from "./io.ts";

export const DEPLOY_USAGE = `Usage: bunvex deploy [options]

Bundle the functions directory and push it to a self-hosted deployment.

Options:
  --url <url>          the deployment (default: BUNVEX_SELF_HOSTED_URL)
  --admin-key <key>    its admin key (default: BUNVEX_SELF_HOSTED_ADMIN_KEY)
  --dry-run            analyze the push without changing the deployment
  --env-file <path>    read BUNVEX_SELF_HOSTED_* from this file instead of .env.local / .env
  --codegen <mode>     enable (default) or disable: regenerate _generated/
  --typecheck <mode>   enable, try (default) or disable: typecheck the functions before finishing the push

The functions directory is bunvex/, or "functions" in bunvex.json.`;

/** `KEY=value` lines (quotes stripped, `#` comments ignored), as dotenv reads them. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2]!;
    const quoted = /^([\x22\x27])(.*?)\1(\s+#.*)?$/.exec(value); // a value in single or double quotes
    if (quoted) value = quoted[2]!;
    else value = value.replace(/\s+#.*$/, "");
    out[m[1]!] = value;
  }
  return out;
}

type ProjectConfig = { functions?: unknown; codegen?: { fileType?: unknown } };

function readProjectConfig(cwd: string): ProjectConfig {
  const configPath = join(cwd, "bunvex.json");
  return existsSync(configPath) ? (JSON.parse(readFileSync(configPath, "utf8")) as ProjectConfig) : {};
}

export function functionsDir(cwd: string): string {
  const config = readProjectConfig(cwd);
  if (config.functions !== undefined) {
    if (typeof config.functions !== "string") throw new Error(`bunvex.json: "functions" must be a string`);
    return resolve(cwd, config.functions);
  }
  return resolve(cwd, "bunvex");
}

/** bunvex.json's `codegen` (Convex's `codegen.fileType`: `.js` + `.d.ts` pairs by default, or `.ts`). */
export function codegenConfig(cwd: string): CodegenConfig {
  const fileType = readProjectConfig(cwd).codegen?.fileType ?? "js/dts";
  if (fileType !== "ts" && fileType !== "js/dts")
    throw new Error(`bunvex.json: "codegen.fileType" must be "ts" or "js/dts"`);
  return { fileType };
}

const sha256 = (m: ModuleConfig) =>
  createHash("sha256")
    .update(m.source)
    .update(m.sourceMap ?? "")
    .digest("hex");

// As Convex's partitionModulesByChanges: a module whose hash and runtime match the deployed one travels as
// its hash only.
export function partitionModules(
  modules: ModuleConfig[],
  remote: { path: string; hash: string; environment: string }[],
) {
  const byPath = new Map(remote.map((h) => [h.path, h]));
  const same = (m: ModuleConfig) => {
    const h = byPath.get(m.path);
    return !!h && h.hash === sha256(m) && h.environment === m.environment;
  };
  return {
    changedModules: modules.filter((m) => !same(m)),
    unchangedModuleHashes: modules
      .filter(same)
      .map((m) => ({ path: m.path, environment: m.environment, sha256: sha256(m) })),
  };
}

type Flags = {
  url?: string;
  adminKey?: string;
  dryRun: boolean;
  envFile?: string;
  codegen: boolean;
  typecheck: TypecheckMode;
};
function parseFlags(args: string[]): Flags | string {
  const f: Flags = { dryRun: false, codegen: true, typecheck: "try" };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const [name, inline] = a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a, undefined];
    if (name === "--dry-run") f.dryRun = true;
    else if (name === "--codegen" || name === "--typecheck") {
      const v = inline ?? args[++i];
      if (name === "--codegen") {
        if (v !== "enable" && v !== "disable") return "--codegen must be enable or disable";
        f.codegen = v === "enable";
      } else {
        if (v !== "enable" && v !== "try" && v !== "disable") return "--typecheck must be enable, try or disable";
        f.typecheck = v;
      }
    } else if (name === "--url" || name === "--admin-key" || name === "--env-file") {
      const v = inline ?? args[++i];
      if (!v) return `${name} needs a value`;
      if (name === "--url") f.url = v;
      else if (name === "--admin-key") f.adminKey = v;
      else f.envFile = v;
    } else return `unknown option ${a}`;
  }
  return f;
}

/** The target from the flags, else the environment, else the env files. */
function target(flags: Flags, io: Io) {
  const files = flags.envFile ? [resolve(io.cwd, flags.envFile)] : [join(io.cwd, ".env.local"), join(io.cwd, ".env")];
  const fromFiles: Record<string, string> = {};
  for (const f of files.reverse()) if (existsSync(f)) Object.assign(fromFiles, parseEnvFile(readFileSync(f, "utf8")));
  const get = (k: string) => io.env[k] || fromFiles[k] || undefined;
  return {
    url: (flags.url ?? get("BUNVEX_SELF_HOSTED_URL"))?.replace(/\/$/, ""),
    adminKey: flags.adminKey ?? get("BUNVEX_SELF_HOSTED_ADMIN_KEY"),
  };
}

export async function deployCommand(args: string[], io: Io): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    io.out(DEPLOY_USAGE);
    return 0;
  }
  const flags = parseFlags(args);
  if (typeof flags === "string") {
    io.err(`bunvex deploy: ${flags}\n\n${DEPLOY_USAGE}`);
    return 2;
  }
  const { url, adminKey } = target(flags, io);
  if (!url || !adminKey) {
    io.err(
      "bunvex deploy: no deployment: set BUNVEX_SELF_HOSTED_URL and BUNVEX_SELF_HOSTED_ADMIN_KEY (in the environment or .env.local), or pass --url and --admin-key",
    );
    return 1;
  }
  let bundled: Awaited<ReturnType<typeof bundleFunctions>>;
  let dir: string;
  let codegen: CodegenConfig;
  try {
    dir = functionsDir(io.cwd);
    codegen = codegenConfig(io.cwd);
    // Convex's initial codegen: what modules importing `_generated/` need to bundle.
    if (flags.codegen && existsSync(dir)) runCodegen(dir, codegen, { initial: true });
    bundled = await bundleFunctions(dir);
  } catch (e) {
    io.err(`bunvex deploy: ${e instanceof BundleError ? e.message : (e as Error).message}`);
    return 1;
  }
  const post = async (path: string, body: object) => {
    let r: Response;
    try {
      r = await fetch(`${url}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bunvex ${adminKey}` },
        body: JSON.stringify({ adminKey, ...body }),
      });
    } catch (e) {
      throw new Error(`could not reach ${url}: ${(e as Error).message}`);
    }
    const text = await r.text();
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new Error(`${url}${path} answered ${r.status}: ${text.slice(0, 200)}`);
    }
    if (!r.ok) throw new Error(String(json.message ?? `${r.status} ${json.code ?? ""}`));
    return json;
  };
  try {
    const hashes = (await post("/api/get_config_hashes", {})).moduleHashes as {
      path: string;
      hash: string;
      environment: string;
    }[];
    const { changedModules, unchangedModuleHashes } = partitionModules(bundled.modules, hashes);
    const start = await post("/api/deploy2/start_push", {
      dryRun: flags.dryRun,
      functions: "bunvex",
      appDefinition: {
        definition: null,
        dependencies: [],
        schema: bundled.schema,
        changedModules,
        unchangedModuleHashes,
        udfServerVersion: "bunvex",
      },
      componentDefinitions: [],
      nodeDependencies: [],
    });
    // Convex's final codegen and typecheck, after the push is analyzed and before it is finished.
    if (flags.codegen) runCodegen(dir, codegen);
    const checked = await typecheck(dir, io.cwd, flags.typecheck);
    if (!checked.ok) {
      io.err(checked.output);
      io.err("To ignore failing typecheck, use `--typecheck=disable`.");
      return 1;
    }
    if (checked.skipped && checked.skipped !== "disabled") io.err(checked.skipped);
    if (flags.dryRun) {
      const fns = Object.values(
        (start.analysis as Record<string, { functions: Record<string, { functions: unknown[] }> }>)[""]!.functions,
      );
      io.out(
        `Dry run: ${bundled.modules.length} modules, ${fns.reduce((n, m) => n + m.functions.length, 0)} functions; nothing was changed.`,
      );
      return 0;
    }
    for (;;) {
      const s = await post("/api/deploy2/wait_for_schema", { schemaChange: start.schemaChange, timeoutMs: 10_000 });
      if (s.type === "complete") break;
      if (s.type === "failed") {
        io.err(`Schema validation failed${s.tableName ? ` in table "${s.tableName}"` : ""}.\n${s.error}`);
        return 1;
      }
      if (s.type === "raceDetected") {
        io.err("Schema was overwritten by another push.");
        return 1;
      }
      const c = (s.components as Record<string, { indexesComplete: number; indexesTotal: number }>)[""];
      io.err(
        `Backfilling indexes (${c?.indexesComplete ?? 0}/${c?.indexesTotal ?? 0} ready) and checking that documents match your schema...`,
      );
    }
    const diff = (await post("/api/deploy2/finish_push", { startPush: start, dryRun: false })) as {
      componentDiffs: Record<
        string,
        {
          moduleDiff: { added: string[]; removed: string[] };
          cronDiff: { added: string[]; updated: string[]; deleted: string[] };
          indexDiff: { added_indexes: string[]; removed_indexes: string[] };
        }
      >;
    };
    void post("/api/deploy2/report_push_completed", { spans: [] }).catch(() => {});
    const d = diff.componentDiffs[""];
    if (d) {
      for (const i of d.indexDiff.added_indexes) io.err(`  [+] index ${i}`);
      for (const i of d.indexDiff.removed_indexes) io.err(`  [-] index ${i}`);
      for (const c of d.cronDiff.added) io.err(`  [+] cron ${c}`);
      for (const c of d.cronDiff.deleted) io.err(`  [-] cron ${c}`);
    }
    io.out(`✔ Deployed functions to ${url}`);
    return 0;
  } catch (e) {
    io.err(`bunvex deploy: ${(e as Error).message}`);
    return 1;
  }
}
