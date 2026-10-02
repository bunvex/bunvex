// Which deployment a command talks to (STUDY-35 DV-171), shared by `deploy`, `env`, `run` and `dev`: `--url` /
// `--admin-key`, else BUNVEX_SELF_HOSTED_URL / BUNVEX_SELF_HOSTED_ADMIN_KEY from the environment, then
// `.env.local`, then `.env` (or `--env-file`), as Convex's CLI reads CONVEX_SELF_HOSTED_*.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Io } from "./io.ts";

export type TargetFlags = { url?: string; adminKey?: string; envFile?: string };
export type Target = { url: string; adminKey: string };

export const TARGET_OPTIONS = `  --url <url>          the deployment (default: BUNVEX_SELF_HOSTED_URL)
  --admin-key <key>    its admin key (default: BUNVEX_SELF_HOSTED_ADMIN_KEY)
  --env-file <path>    read BUNVEX_SELF_HOSTED_* from this file instead of .env.local / .env`;

export const NO_DEPLOYMENT =
  "no deployment: set BUNVEX_SELF_HOSTED_URL and BUNVEX_SELF_HOSTED_ADMIN_KEY (in the environment or .env.local), or pass --url and --admin-key";

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

/** Take `--url`, `--admin-key` and `--env-file` out of `args`: the flags and the other arguments. */
export function takeTargetFlags(args: string[]): { flags: TargetFlags; rest: string[] } | string {
  const flags: TargetFlags = {};
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const [name, inline] = a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a, undefined];
    if (name === "--url" || name === "--admin-key" || name === "--env-file") {
      const v = inline ?? args[++i];
      if (!v) return `${name} needs a value`;
      if (name === "--url") flags.url = v;
      else if (name === "--admin-key") flags.adminKey = v;
      else flags.envFile = v;
    } else rest.push(a);
  }
  return { flags, rest };
}

/** The target from the flags, else the environment, else the env files; null when either part is missing. */
export function resolveTarget(flags: TargetFlags, io: Io): Target | null {
  const files = flags.envFile ? [resolve(io.cwd, flags.envFile)] : [join(io.cwd, ".env.local"), join(io.cwd, ".env")];
  const fromFiles: Record<string, string> = {};
  for (const f of files.reverse()) if (existsSync(f)) Object.assign(fromFiles, parseEnvFile(readFileSync(f, "utf8")));
  const get = (k: string) => io.env[k] || fromFiles[k] || undefined;
  const url = (flags.url ?? get("BUNVEX_SELF_HOSTED_URL"))?.replace(/\/$/, "");
  const adminKey = flags.adminKey ?? get("BUNVEX_SELF_HOSTED_ADMIN_KEY");
  return url && adminKey ? { url, adminKey } : null;
}

/** A request to the deployment with its admin key; the JSON answer (or null for an empty one), or throws its message. */
export async function adminRequest(
  target: Target,
  path: string,
  body?: object,
): Promise<Record<string, unknown> | null> {
  let r: Response;
  try {
    r = await fetch(`${target.url}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", authorization: `Bunvex ${target.adminKey}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (e) {
    throw new Error(`could not reach ${target.url}: ${(e as Error).message}`);
  }
  const text = await r.text();
  if (!text && r.ok) return null;
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`${target.url}${path} answered ${r.status}: ${text.slice(0, 200)}`);
  }
  if (!r.ok) throw new Error(String(json.message ?? `${r.status} ${json.code ?? ""}`));
  return json;
}
