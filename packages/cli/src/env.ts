// `bunvex env` (STUDY-37 PR 2): the deployment's environment variables, as Convex's `npx convex env`
// (npm-packages/convex/src/cli/env.ts, lib/env.ts): `set`, `get`, `remove` (`rm`, `unset`) and `list`, with
// Convex's argument forms, value sources (argument, `--from-file`, piped stdin, a prompt), messages,
// stdout vs stderr, and exit codes. Reads use `GET /api/list_environment_variables`; writes
// `POST /api/update_environment_variables`.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Io } from "./io.ts";
import {
  adminRequest,
  NO_DEPLOYMENT,
  parseEnvFile,
  resolveTarget,
  TARGET_OPTIONS,
  type Target,
  takeTargetFlags,
} from "./target.ts";

export const ENV_USAGE = `Usage: bunvex env <command> [options]

Set and view the deployment's environment variables.

Commands:
  set [name] [value]   set a variable (\`bunvex env set NAME value\`, \`NAME=value\`, from stdin or a prompt),
                       or many from a .env file (\`--from-file <file>\`, or piped stdin)
  get <name>           print a variable's value
  remove <name>        unset a variable (aliases: rm, unset)
  list                 list the variables (\`--names-only\` for their names)

Options:
${TARGET_OPTIONS}
  --from-file <file>   set: read the value (with a name) or variables (without) from a file
  --force              set: overwrite existing variables that have different values
  --names-only         list: print only the names`;

/** The variables the CLI itself reads: never sent to the deployment from a .env file. */
const CLI_MANAGED = new Set([
  "BUNVEX_SELF_HOSTED_URL",
  "BUNVEX_SELF_HOSTED_ADMIN_KEY",
  ...["", "PUBLIC_", "NEXT_PUBLIC_", "VITE_", "REACT_APP_", "EXPO_PUBLIC_"].flatMap((p) => [
    `${p}BUNVEX_URL`,
    `${p}BUNVEX_SITE_URL`,
  ]),
]);

/** "A", "A and B", "A, B, and C". */
const formatList = (items: string[]) =>
  items.length <= 1
    ? (items[0] ?? "")
    : items.length === 2
      ? `${items[0]} and ${items[1]}`
      : `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Convex's `formatEnvValueForDotfile`: a value as a .env line can hold it, and a warning when it may not. */
export function formatEnvValueForDotfile(value: string): { formatted: string; warning?: string } {
  let formatted = value;
  let warning: string | undefined;
  const newline = value.includes("\n");
  const single = value.includes("'");
  const double = value.includes('"');
  const slashN = value.includes("\\n");
  const comment = value.includes("#")
    ? "includes a '#' which may be interpreted as a comment if you save this value to a .env file, resulting in only reading a partial value."
    : undefined;
  if (newline) {
    if (!single) formatted = `'${value}'`;
    else if (!slashN) {
      if (double && comment) warning = comment;
      formatted = `"${value.replaceAll("\n", "\\n")}"`;
    } else {
      formatted = `'${value}'`;
      warning = `includes single quotes, newlines and "\\n" in the value. If you save this value to a .env file, it may not round-trip.`;
    }
  } else if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'")) ||
    value.startsWith("`") ||
    value.endsWith("`") ||
    value.includes("\f") ||
    value.includes("\v") ||
    comment
  ) {
    if (single && !double && !slashN) formatted = `"${value}"`;
    else {
      formatted = `'${value}'`;
      if (single && comment) warning = comment;
    }
  }
  if (value.includes("\r")) {
    warning = warning ? `${warning} It also ` : "";
    warning += "includes carriage return (\\r) which cannot be preserved in .env files (dotenv limitation)";
  }
  return warning === undefined ? { formatted } : { formatted, warning };
}

/** A failure with Convex's exit code 1 and message. */
class EnvFailure extends Error {}

type Backend = {
  list: () => Promise<{ name: string; value: string }[]>;
  update: (changes: { name: string; value: string | null }[]) => Promise<void>;
};

function backendOf(target: Target): Backend {
  return {
    list: async () => {
      const r = (await adminRequest(target, "/api/list_environment_variables")) as {
        environmentVariables: Record<string, string>;
      };
      return Object.entries(r.environmentVariables).map(([name, value]) => ({ name, value }));
    },
    update: async (changes) => {
      await adminRequest(target, "/api/update_environment_variables", { changes });
    },
  };
}

function readFile(io: Io, file: string) {
  const path = resolve(io.cwd, file);
  if (!existsSync(path)) throw new EnvFailure(`error: file not found: ${file}`);
  return readFileSync(path, "utf8");
}

async function readStdin(io: Io): Promise<string | null> {
  try {
    return (await io.stdin?.()) ?? null;
  } catch (e) {
    throw new EnvFailure(`error: failed to read from stdin: ${(e as Error).message}`);
  }
}

/** Many variables from a .env file's text: new ones set, equal ones left, different ones only with `--force`. */
async function setMany(io: Io, b: Backend, content: string, source: string, force: boolean) {
  const parsed = Object.entries(parseEnvFile(content));
  const skipped = parsed.filter(([n]) => CLI_MANAGED.has(n)).map(([n]) => n);
  const toSet = parsed.filter(([n]) => !CLI_MANAGED.has(n));
  if (skipped.length)
    io.err(`Skipping ${plural(skipped.length, "CLI-managed environment variable")}: ${formatList(skipped)}`);
  if (!toSet.length) {
    if (!parsed.length) io.err(`No environment variables found in ${source}.`);
    return;
  }
  const existing = new Map((await b.list()).map((v) => [v.name, v.value]));
  const fresh: [string, string][] = [];
  const updated: [string, string][] = [];
  const unchanged: [string, string][] = [];
  const conflicts: string[] = [];
  for (const [name, value] of toSet) {
    const old = existing.get(name);
    if (old === undefined) fresh.push([name, value]);
    else if (old === value) unchanged.push([name, value]);
    else if (force) updated.push([name, value]);
    else conflicts.push(name);
  }
  if (conflicts.length) {
    const one = conflicts.length === 1;
    throw new EnvFailure(
      `error: environment variable${one ? "" : "s"} ${formatList(conflicts)} already exist${one ? "s" : ""} with different value${one ? "" : "s"}.\n\nUse --force to overwrite existing values.`,
    );
  }
  const changes = [...fresh, ...updated].map(([name, value]) => ({ name, value }));
  if (changes.length) await b.update(changes);
  const parts = [
    fresh.length ? `${fresh.length} new` : "",
    updated.length ? `${updated.length} updated` : "",
    unchanged.length ? `${unchanged.length} unchanged` : "",
  ].filter(Boolean);
  const total = fresh.length + updated.length + unchanged.length;
  if (!changes.length) io.err(`All ${plural(total, "environment variable")} from ${source} already set`);
  else
    io.err(`✔ Successfully set ${plural(changes.length, "environment variable")} from ${source} (${parts.join(", ")})`);
}

async function set(io: Io, b: Backend, positional: string[], opts: { fromFile?: string; force: boolean }) {
  const [name, value] = positional;
  if (positional.length > 2)
    throw new EnvFailure(`error: too many arguments for 'set'. Expected 2 arguments but got ${positional.length}.`);
  if (name === undefined) {
    if (opts.fromFile) return setMany(io, b, readFile(io, opts.fromFile), opts.fromFile, opts.force);
    const piped = await readStdin(io);
    if (piped !== null) return setMany(io, b, piped, "stdin", opts.force);
    io.err(ENV_USAGE);
    throw new EnvFailure("error: No environment variables specified to be set.");
  }
  let n = name;
  let v: string;
  const eq = /^[a-zA-Z][a-zA-Z0-9_]*=/.exec(name);
  if (eq) {
    if (value !== undefined)
      throw new EnvFailure(
        `When setting an environment variable, you can either set a value with 'NAME=value', or with NAME value, but not both. Are you missing quotes around the CLI argument? Try: \n  bunvex env set '${name} ${value}'`,
      );
    n = name.slice(0, name.indexOf("="));
    v = name.slice(name.indexOf("=") + 1);
  } else if (value !== undefined) v = value;
  else if (opts.fromFile) v = readFile(io, opts.fromFile);
  else {
    const piped = await readStdin(io);
    if (piped !== null) v = piped;
    else {
      const asked = io.prompt?.(`Enter value for ${n}:`);
      if (asked === null || asked === undefined) throw new EnvFailure(`error: no value given for ${n}`);
      v = asked;
    }
  }
  await b.update([{ name: n, value: v }]);
  io.err(`✔ Successfully set ${n}`);
}

export async function envCommand(args: string[], io: Io): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === undefined || sub === "--help" || sub === "-h" || rest.includes("--help") || rest.includes("-h")) {
    io.out(ENV_USAGE);
    return sub === undefined ? 1 : 0;
  }
  const taken = takeTargetFlags(rest);
  if (typeof taken === "string") {
    io.err(`bunvex env: ${taken}`);
    return 2;
  }
  let fromFile: string | undefined;
  let force = false;
  let namesOnly = false;
  const positional: string[] = [];
  const r = taken.rest;
  for (let i = 0; i < r.length; i++) {
    const a = r[i]!;
    if (a === "--force" && sub === "set") force = true;
    else if (a === "--names-only" && sub === "list") namesOnly = true;
    else if ((a === "--from-file" || a.startsWith("--from-file=")) && sub === "set") {
      fromFile = a.includes("=") ? a.slice(a.indexOf("=") + 1) : r[++i];
      if (!fromFile) {
        io.err("bunvex env: --from-file needs a value");
        return 2;
      }
    } else if (a.startsWith("--")) {
      io.err(`bunvex env: unknown option ${a}\n\n${ENV_USAGE}`);
      return 2;
    } else positional.push(a);
  }
  if (!["set", "get", "remove", "rm", "unset", "list"].includes(sub)) {
    io.err(`bunvex env: unknown command ${sub}\n\n${ENV_USAGE}`);
    return 2;
  }
  const target = resolveTarget(taken.flags, io);
  if (!target) {
    io.err(`bunvex env: ${NO_DEPLOYMENT}`);
    return 1;
  }
  const b = backendOf(target);
  try {
    if (sub === "set") await set(io, b, positional, { fromFile, force });
    else if (sub === "get") {
      const name = positional[0];
      if (!name || positional.length > 1) throw new EnvFailure("error: get takes one argument: the variable's name");
      const found = (await b.list()).find((v) => v.name === name);
      // As Convex: a missing variable is reported, and the exit code is still 0.
      if (!found) io.err(`✖ Environment variable "${name}" not found`);
      else io.out(found.value);
    } else if (sub === "list") {
      if (positional.length) throw new EnvFailure("error: list takes no arguments");
      const vars = (await b.list()).sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
      if (!vars.length) io.err("No environment variables set");
      for (const { name, value } of vars) {
        if (namesOnly) {
          io.out(name);
          continue;
        }
        const { formatted, warning } = formatEnvValueForDotfile(value);
        if (warning) io.err(`Warning (${name}): ${warning}`);
        io.out(`${name}=${formatted}`);
      }
    } else {
      const name = positional[0];
      if (!name || positional.length > 1) throw new EnvFailure(`error: ${sub} takes one argument: the variable's name`);
      await b.update([{ name, value: null }]);
      io.err(`✔ Successfully unset ${name}`);
    }
    return 0;
  } catch (e) {
    io.err(e instanceof EnvFailure ? e.message : `✖ ${(e as Error).message}`);
    return 1;
  }
}
