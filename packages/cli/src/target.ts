// Which deployment a command talks to (STUDY-35 DV-171), shared by `deploy`, `env`, `run` and `dev`: `--url` /
// `--admin-key`, else BUNVEX_SELF_HOSTED_URL / BUNVEX_SELF_HOSTED_ADMIN_KEY from the environment, then
// `.env.local`, then `.env` (or `--env-file`), as Convex's CLI reads CONVEX_SELF_HOSTED_*.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { missingArgument } from "./args.ts";
import type { Io } from "./io.ts";

export type TargetFlags = { url?: string; adminKey?: string; envFile?: string };
export type Target = { url: string; adminKey: string };

export const TARGET_OPTIONS = `  --url <url>          the deployment (default: BUNVEX_SELF_HOSTED_URL)
  --admin-key <key>    its admin key (default: BUNVEX_SELF_HOSTED_ADMIN_KEY)
  --env-file <path>    read BUNVEX_SELF_HOSTED_* from this file instead of .env.local / .env`;

/** No deployment configured: Convex's message (`loadSelectedDeploymentCredentials`), with bunvex's names. */
export const NO_DEPLOYMENT = "No BUNVEX_DEPLOYMENT set, run `bunvex dev` to configure a bunvex project";

// One assignment of a .env file, read as dotenv 16's `parse` reads it (Convex's CLI uses dotenv for `.env`,
// `.env.local` and `env set --from-file`): from the start of a line, an optional `export`, a name of word
// characters, `.` and `-`, then `=` (or `:` and a space), then a value in single, double or backtick quotes
// (which may span lines; an escaped quote does not end it) or an unquoted run up to `#` or the end of the
// line, then an optional `# comment`.
const ASSIGNMENT = new RegExp(
  [
    String.raw`^\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)`,
    String.raw`(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*\x60(?:\\\x60|[^\x60])*\x60|[^#\r\n]+)?`,
    String.raw`\s*(?:#.*)?$`,
  ].join(""),
  "gm",
);

/**
 * A .env file's variables, as dotenv reads them: comments and lines that are not assignments skipped,
 * the value trimmed, one pair of matching outer quotes removed, `\n` and `\r` expanded in double quotes,
 * multi-line quoted values kept whole, the last assignment of a name winning.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const src = text.replace(/\r\n?/g, "\n");
  for (const m of src.matchAll(ASSIGNMENT)) {
    let value = (m[2] ?? "").trim();
    const first = value[0];
    if (value.length >= 2 && (first === "'" || first === '"' || first === "\x60") && value.endsWith(first))
      value = value.slice(1, -1);
    if (first === '"') value = value.replaceAll("\\n", "\n").replaceAll("\\r", "\r");
    out[m[1]!] = value;
  }
  return out;
}

/** The target options as Convex's commander spells them (`lib/command.ts`), for its messages. */
export const TARGET_SPECS: Record<string, string> = {
  "--url": "--url <url>",
  "--admin-key": "--admin-key <adminKey>",
  "--env-file": "--env-file <envFile>",
};

/** Take `--url`, `--admin-key` and `--env-file` out of `args`: the flags and the other arguments. */
export function takeTargetFlags(args: string[]): { flags: TargetFlags; rest: string[] } | string {
  const flags: TargetFlags = {};
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const [name, inline] = a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a, undefined];
    if (name === "--url" || name === "--admin-key" || name === "--env-file") {
      const v = inline ?? args[++i];
      if (!v) return missingArgument(TARGET_SPECS[name]!);
      if (name === "--url") flags.url = v;
      else if (name === "--admin-key") flags.adminKey = v;
      else flags.envFile = v;
    } else rest.push(a);
  }
  return { flags, rest };
}

/**
 * The deployment variables as Convex's CLI reads them (`resolveBaseDeploymentSelection`,
 * cli/lib/deploymentSelection.ts): with `--env-file`, that file alone (it must exist); otherwise the
 * environment, then `.env.local`, then `.env`, each filling only what is still unset (dotenv's `config`). An empty
 * value is no value.
 */
export function deploymentVariables(flags: TargetFlags, io: Io): (name: string) => string | null {
  if (flags.envFile) {
    const path = resolve(io.cwd, flags.envFile);
    if (!existsSync(path)) throw new Error("env file does not exist");
    const config = parseEnvFile(readFileSync(path, "utf8"));
    return (name) => config[name] || null;
  }
  const files = [join(io.cwd, ".env.local"), join(io.cwd, ".env")]
    .filter((f) => existsSync(f))
    .map((f) => parseEnvFile(readFileSync(f, "utf8")));
  return (name) => {
    const set = io.env[name] !== undefined ? io.env[name] : files.find((c) => name in c)?.[name];
    return set || null;
  };
}

/**
 * The self-hosted target, as Convex's `_getDeploymentSelection` and `getDeploymentSelectionFromEnv` choose it:
 * `--url` with `--admin-key` (both, or neither counts), else `BUNVEX_SELF_HOSTED_URL` with
 * `BUNVEX_SELF_HOSTED_ADMIN_KEY`; null when neither (a local deployment, `BUNVEX_DEPLOYMENT`, may be next).
 * Convex's checks: those variables and `BUNVEX_DEPLOYMENT` may not be set together, and an `--env-file` must
 * name a deployment.
 */
export function resolveTarget(flags: TargetFlags, io: Io): Target | null {
  if (flags.url !== undefined && flags.adminKey !== undefined)
    return { url: flags.url.replace(/\/$/, ""), adminKey: flags.adminKey };
  const get = deploymentVariables(flags, io);
  const deployment = get("BUNVEX_DEPLOYMENT");
  const url = get("BUNVEX_SELF_HOSTED_URL");
  const adminKey = get("BUNVEX_SELF_HOSTED_ADMIN_KEY");
  if (url !== null && adminKey !== null) {
    if (deployment !== null)
      throw new Error(
        "BUNVEX_DEPLOYMENT must not be set when BUNVEX_SELF_HOSTED_URL and BUNVEX_SELF_HOSTED_ADMIN_KEY are set",
      );
    return { url: url.replace(/\/$/, ""), adminKey };
  }
  if (deployment !== null && (url !== null || adminKey !== null))
    throw new Error(
      "BUNVEX_SELF_HOSTED_URL and BUNVEX_SELF_HOSTED_ADMIN_KEY must not be set when BUNVEX_DEPLOYMENT is set",
    );
  if (flags.envFile && deployment === null)
    throw new Error(
      `env file \`${flags.envFile}\` did not contain environment variables for a bunvex deployment. Expected \`BUNVEX_DEPLOYMENT\`, or both \`BUNVEX_SELF_HOSTED_URL\` and \`BUNVEX_SELF_HOSTED_ADMIN_KEY\` to be set.`,
    );
  return null;
}

/** A request to the deployment with its admin key; the JSON answer (or null for an empty one), or throws its message. */
/**
 * A function call's body asks for the encoded form, as Convex's CLI (through its HTTP client) does: the
 * server's default is clean JSON (STUDY-67 H3), which loses int64 and bytes.
 */
const withFormat = (path: string, body: object) =>
  /^\/api\/(query|mutation|action|function|query_at_ts)$/.test(path) && !("format" in body)
    ? { ...body, format: "encoded_json" }
    : body;

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
      ...(body === undefined ? {} : { body: JSON.stringify(withFormat(path, body)) }),
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
