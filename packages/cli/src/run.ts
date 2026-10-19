// `bunvex run` (STUDY-37 PR 3): run a function on the deployment, as Convex's `npx convex run`
// (npm-packages/convex/src/cli/run.ts, lib/run.ts): any kind, internal ones included (an admin key), through
// `POST /api/function`; JSON5 arguments; `--identity` to act as a user; the function's log lines on stderr,
// its result on stdout; the deployment's functions listed when the name is not one of them; `--push` deploys
// first; `--watch` subscribes to a query over a WebSocket and prints each new result; `--inline-query` evaluates
// a readonly query through the deployment's function tester (STUDY-119); `--component <path>` runs a component's
// function, as Convex's (STUDY-156 PR 3).
import { existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { BaseBunvexClient, type Logger, type QueryToken } from "@bunvex/client";
import { makeFunctionReference } from "@bunvex/protocol";
import { fromJsonValue, type JSONValue, toJsonValue, type Value } from "@bunvex/values";
import {
  argumentError,
  conflictingOptions,
  invalidChoice,
  missingArgument,
  optionsIn,
  tooManyArguments,
  unknownOption,
} from "./args.ts";
import { deployCommand, functionsDir } from "./deploy.ts";
import { INLINE_QUERY_HELP, inlineQuerySource, runTestQuery, TestQueryRequestError } from "./inline-query.ts";
import type { Io } from "./io.ts";
import { parseJson5 } from "./json5.ts";
import { acquireTarget } from "./local-deployment.ts";
import { adminRequest, NO_DEPLOYMENT, TARGET_OPTIONS, type Target, takeTargetFlags } from "./target.ts";

export const RUN_USAGE = `Usage: bunvex run [options] [functionName] [args]

Run a function (query, mutation or action) on the deployment, internal ones too, or evaluate an inline
readonly query.

  functionName   \`messages:list\`, \`dir/file\` (its default export), or \`api.messages.list\`
  args           a JSON5 object of arguments (default: {})

Options:
${TARGET_OPTIONS}
  --identity <json5>   act as this user (e.g. '{ name: "Ada", email: "ada@example.com" }')
  -w, --watch          a query: print its result, and again each time it changes (Ctrl-C to stop)
  --inline-query <query>
                       ${INLINE_QUERY_HELP}
  --component <path>   the component the function is in (\`counter\`, \`parent/child\`); the app's by default
  --push               deploy the functions first (with --typecheck / --codegen as \`bunvex deploy\`)
  --typecheck <mode>   for --push: enable, try (default) or disable
  --typecheck-components
                       for --push: also typecheck the local components' directories
  --codegen <mode>     for --push: enable (default) or disable`;

const EXTENSIONS = [".ts", ".js", ".tsx", ".jsx", ".mts", ".mjs", ".cts", ".cjs"];

/**
 * Convex's `parseFunctionName`: `api.a.b` / `internal.a.b` → `a:b`; `a/b` → `a/b:default`; an extension is
 * dropped; a leading functions directory (`bunvex/a`) is dropped unless such a file exists under it.
 */
export function parseFunctionName(name: string, cwd: string, fnDir: string): string {
  if (name.startsWith("api.") || name.startsWith("internal.")) {
    const parts = name.split(".");
    if (parts.length < 3) throw new RunFailure(`Function name has too few parts: "${name}"`);
    const exportName = parts.pop();
    return `${parts.slice(1).join("/")}:${exportName}`;
  }
  const filePath = name.split(":")[0]!;
  const ext = EXTENSIONS.find((e) => filePath.endsWith(e));
  const normalized = ext ? filePath.slice(0, -ext.length) : filePath;
  const exportName = name.split(":")[1] ?? "default";
  const dirName = `${relative(cwd, fnDir).split(sep).join("/")}/`;
  if (!filePath.startsWith(dirName)) return `${normalized}:${exportName}`;
  const exists = ext
    ? existsSync(join(fnDir, filePath))
    : EXTENSIONS.some((e) => existsSync(join(fnDir, filePath + e)));
  return exists ? `${normalized}:${exportName}` : `${normalized.slice(dirName.length)}:${exportName}`;
}

class RunFailure extends Error {}

/** Convex's `simpleHash`: the 32-bit string hash that names a fake identity's subject. */
function simpleHash(s: string) {
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    hash = (hash << 5) - hash + s.charCodeAt(i);
    hash &= hash;
  }
  return hash;
}

/** Convex's `getFakeIdentity`: the given fields, with `subject`, `issuer` and `tokenIdentifier` filled in. */
export function fakeIdentity(text: string): Record<string, unknown> {
  let identity: Record<string, unknown>;
  try {
    identity = parseJson5(text) as Record<string, unknown>;
  } catch (e) {
    throw new RunFailure(`Failed to parse identity as JSON: "${text}"\n${String(e).trim()}`);
  }
  const subject = identity.subject ?? `${simpleHash(JSON.stringify(identity))}`;
  const issuer = identity.issuer ?? "https://bunvex.test";
  const tokenIdentifier = identity.tokenIdentifier ?? `${String(issuer)}|${String(subject)}`;
  return { ...identity, subject, issuer, tokenIdentifier };
}

/** A function's log line, as the client prints it: `[BUNVEX ?(path)] [LEVEL] message`. */
function printLogLine(io: Io, path: string, line: string) {
  const m = /^\[(.*?)\] /.exec(line);
  io.err(m ? `[BUNVEX ?(${path})] [${m[1]}] ${line.slice(m[0].length)}` : `[BUNVEX ?(${path})] ${line}`);
}

type Spec = { functionType: string; identifier?: string };

async function availableFunctions(target: Target, componentPath: string | undefined): Promise<string> {
  let specs: Spec[] = [];
  try {
    // A component's: `apiSpec` in its namespace, by its id (Convex's `componentId` argument).
    const componentId =
      componentPath === undefined
        ? undefined
        : (await mountedComponents(target)).find((c) => c.path === componentPath)?.id;
    const r = (await adminRequest(target, "/api/query", {
      path: "_system/cli/modules:apiSpec",
      args: componentId === undefined ? {} : { componentId },
    })) as { value?: Spec[] };
    specs = r.value ?? [];
  } catch {
    // The list is a courtesy: without it, the error alone.
  }
  const names = specs
    .filter((s) => s.functionType !== "HttpAction" && s.identifier)
    .map((s) => {
      const i = s.identifier!.indexOf(":");
      return i === -1
        ? `• ${s.identifier}`
        : `• ${s.identifier!.slice(0, i).replace(/\.js$/, "")}:${s.identifier!.slice(i + 1)}`;
    });
  return names.length ? `Available functions:\n${names.join("\n")}` : "No functions found.";
}

/**
 * `--watch` (Convex's `subscribeAndLog`): the query over a WebSocket, each new result printed, until stopped
 * (Ctrl-C, or `signal`).
 */
async function watchQuery(
  io: Io,
  target: Target,
  path: string,
  rawName: string,
  args: Record<string, Value>,
  identity: Record<string, unknown> | undefined,
  componentPath: string | undefined,
  signal?: AbortSignal,
): Promise<number> {
  const logger: Logger = {
    logVerbose: () => {},
    // The client prints a function's log lines as `%c[BUNVEX Q(path)] [LEVEL]`, the style, then the text.
    log: (...a) =>
      io.err(
        a
          .filter((x, i) => !(i === 1 && typeof a[0] === "string" && a[0].includes("%c")))
          .map(String)
          .join(" ")
          .replace("%c", ""),
      ),
    warn: (...a) => io.err(a.map(String).join(" ")),
    error: (...a) => io.err(a.map(String).join(" ")),
  };
  const stop = new AbortController();
  let code = 0;
  let token: QueryToken | undefined;
  // The base client, as Convex's `subscribeAndLog`: it subscribes with a component's path.
  const client = new BaseBunvexClient(
    target.url,
    (updated) => {
      if (token === undefined || !updated.includes(token)) return;
      try {
        io.out(printValue(io, client.localQueryResultByToken(token) as Value));
      } catch (e) {
        io.err(`Failed to run function "${rawName}":\n${(e as Error).message.trim()}`);
        code = 1;
        stop.abort();
      }
    },
    { logger },
  );
  client.setAdminAuth(target.adminKey, identity as never);
  io.err(`✔ Watching query ${rawName} on ${target.url}...`);
  const onSigint = () => stop.abort();
  if (signal) signal.addEventListener("abort", onSigint, { once: true });
  else process.once("SIGINT", onSigint);
  const sub = client.subscribe(path, args, componentPath === undefined ? {} : { componentPath });
  token = sub.queryToken;
  await new Promise<void>((done) => {
    if (stop.signal.aborted) return done();
    stop.signal.addEventListener("abort", () => done(), { once: true });
  });
  if (!signal) process.off("SIGINT", onSigint);
  if (code === 0) io.err(`Closing connection to ${target.url}...`);
  sub.unsubscribe();
  await client.close();
  return code;
}

/** A result, for people on a terminal, else as JSON. */
function printValue(io: Io, value: Value) {
  return io.isTTY
    ? Bun.inspect(value, { colors: true, depth: Number.POSITIVE_INFINITY })
    : JSON.stringify(toJsonValue(value), null, 2);
}

/** The deployment's components, by id and path (`_system/frontend/components:list`). */
async function mountedComponents(target: Target): Promise<{ id: string; path: string }[]> {
  const r = (await adminRequest(target, "/api/query", { path: "_system/frontend/components:list", args: {} })) as {
    value?: { id: string; path: string }[];
  };
  return r.value ?? [];
}

/**
 * Convex's `resolveInlineQueryComponentId`: `--component`'s path to its id (`_system/frontend/components:list`),
 * none for the app (no flag, or `_App`); an empty or unknown path ends the run with Convex's message.
 */
async function inlineQueryComponentId(target: Target, componentPath: string | undefined) {
  const path = componentPath?.trim();
  if (path === undefined || path === "_App") return undefined;
  if (path.length === 0) throw new RunFailure("`--component` must not be empty.");
  const components = await mountedComponents(target);
  const found = components.find((c) => c.path === path);
  if (found) return found.id;
  const available = components
    .map((c) => c.path)
    .filter((p) => p.length > 0)
    .sort();
  throw new RunFailure(
    `Component path "${path}" was not found.\n\n${
      available.length === 0
        ? "This deployment has no mounted components."
        : `Available components:\n${available.map((p) => `• ${p}`).join("\n")}`
    }\nOmit \`--component\` to target the app root.`,
  );
}

/**
 * `--inline-query` (STUDY-119, Convex's `runInlineQueryInDeployment`): the query's log lines on stderr as the
 * server wrote them, its value on stdout (nothing for null); a failed run is `Query failed: <response>`.
 */
async function inlineQueryRun(
  io: Io,
  target: Target,
  inlineQuery: string,
  componentPath: string | undefined,
): Promise<number> {
  let result: Awaited<ReturnType<typeof runTestQuery>>;
  try {
    const componentId = await inlineQueryComponentId(target, componentPath);
    result = await runTestQuery(target, inlineQuerySource(inlineQuery), componentId);
  } catch (e) {
    if (!(e instanceof TestQueryRequestError || e instanceof RunFailure)) throw e;
    io.err(e.message);
    return 1;
  }
  if (result.kind === "failure") {
    io.err(`Query failed: ${JSON.stringify(result.payload, null, 2)}`);
    return 1;
  }
  for (const line of result.logLines) io.err(line);
  const value = fromJsonValue(result.value as JSONValue);
  if (value !== null) io.out(printValue(io, value));
  return 0;
}

export async function runCommand(args: string[], io: Io, opts: { signal?: AbortSignal } = {}): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    io.out(RUN_USAGE);
    return 0;
  }
  const taken = takeTargetFlags(args);
  // Convex's `run` shows its help after an argument error.
  if (typeof taken === "string") return argumentError(io, taken, RUN_USAGE);
  let identity: string | undefined;
  let push = false;
  let watch = false;
  let inlineQuery: string | undefined;
  let componentPath: string | undefined;
  const pushFlags: string[] = [];
  const positional: string[] = [];
  const r = taken.rest;
  for (let i = 0; i < r.length; i++) {
    const a = r[i]!;
    const [name, inline] = a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a, undefined];
    if (name === "--push") push = true;
    // Convex keeps `--no-push` (hidden) for old scripts: it undoes an earlier `--push`, nothing more.
    else if (name === "--no-push") push = false;
    else if (
      name === "--identity" ||
      name === "--typecheck" ||
      name === "--codegen" ||
      name === "--inline-query" ||
      name === "--component"
    ) {
      const v = inline ?? r[++i];
      const spec =
        name === "--identity"
          ? "--identity <identity>"
          : name === "--inline-query"
            ? "--inline-query <query>"
            : name === "--component"
              ? "--component <path>"
              : `${name} <mode>`;
      if (v === undefined) return argumentError(io, missingArgument(spec), RUN_USAGE);
      const choices = name === "--typecheck" ? ["enable", "try", "disable"] : ["enable", "disable"];
      if ((name === "--typecheck" || name === "--codegen") && !choices.includes(v))
        return argumentError(io, invalidChoice(spec, v, choices), RUN_USAGE);
      if (name === "--identity") identity = v;
      else if (name === "--inline-query") inlineQuery = v;
      else if (name === "--component") componentPath = v;
      else pushFlags.push(`${name}=${v}`);
    } else if (name === "--watch" || name === "-w") watch = true;
    // For `--push`, as `bunvex deploy`'s (`--typecheck-components` typechecks the local components too).
    else if (name === "--typecheck-components" || name === "--live-component-sources") pushFlags.push(name);
    else if (a.startsWith("-") && a !== "-")
      return argumentError(io, unknownOption(a, optionsIn(RUN_USAGE)), RUN_USAGE);
    else positional.push(a);
  }
  // Convex declares `--inline-query` in conflict with `--watch`: its parser (commander) refuses the pair first.
  if (inlineQuery !== undefined && watch)
    return argumentError(io, conflictingOptions("--inline-query <query>", "-w, --watch"), RUN_USAGE);
  if (positional.length > 2) return argumentError(io, tooManyArguments("run", 2, positional.length), RUN_USAGE);
  // Convex's `resolveRunTarget`, in its order.
  const trimmed = inlineQuery?.trim();
  const refuse = (message: string) => {
    io.err(message);
    return 1;
  };
  if (trimmed !== undefined && positional.length)
    return refuse("`bunvex run` accepts either <functionName> or `--inline-query`, not both.");
  if (trimmed === undefined && !positional.length)
    return refuse("`bunvex run` requires either <functionName> or `--inline-query`.");
  if (trimmed === "") return refuse("`--inline-query` must not be empty.");
  if (trimmed !== undefined && identity !== undefined)
    return refuse("`--inline-query` can't be combined with `--identity`.");
  let acquired: Awaited<ReturnType<typeof acquireTarget>>;
  try {
    acquired = await acquireTarget(taken.flags, io);
  } catch (e) {
    io.err(`bunvex run: ${(e as Error).message}`);
    return 1;
  }
  if (!acquired) {
    io.err(`bunvex run: ${NO_DEPLOYMENT}`);
    return 1;
  }
  const target = acquired.target;
  if (trimmed !== undefined)
    try {
      if (push) {
        const code = await deployCommand(["--url", target.url, "--admin-key", target.adminKey, ...pushFlags], io);
        if (code !== 0) return 1;
      }
      return await inlineQueryRun(io, target, trimmed, componentPath);
    } finally {
      await acquired.release();
    }
  const [rawName, argsText = "{}"] = positional as [string, string?];
  try {
    let fnArgs: unknown;
    try {
      fnArgs = parseJson5(argsText);
      fromJsonValue(fnArgs as JSONValue); // a value bunvex can carry
    } catch (e) {
      throw new RunFailure(`Failed to parse arguments as JSON: "${argsText}"\n${String(e).trim()}`);
    }
    const auth = identity
      ? `${target.adminKey}:${Buffer.from(JSON.stringify(fakeIdentity(identity))).toString("base64")}`
      : target.adminKey;
    const path = parseFunctionName(rawName, io.cwd, functionsDir(io.cwd));
    if (push) {
      const code = await deployCommand(["--url", target.url, "--admin-key", target.adminKey, ...pushFlags], io);
      if (code !== 0) return 1;
    }
    if (watch)
      return await watchQuery(
        io,
        target,
        path,
        rawName,
        fromJsonValue(fnArgs as JSONValue) as Record<string, Value>,
        identity ? fakeIdentity(identity) : undefined,
        componentPath,
        opts.signal,
      );
    let res: Response;
    try {
      res = await fetch(`${target.url}/api/function`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bunvex ${auth}` },
        body: JSON.stringify({
          path,
          args: fnArgs,
          format: "encoded_json",
          ...(componentPath === undefined ? {} : { componentPath }),
        }),
      });
    } catch (e) {
      throw new RunFailure(`could not reach ${target.url}: ${(e as Error).message}`);
    }
    const text = await res.text();
    let body: { status?: string; value?: JSONValue; errorMessage?: string; logLines?: string[]; message?: string };
    try {
      body = JSON.parse(text);
    } catch {
      throw new RunFailure(`${target.url}/api/function answered ${res.status}: ${text.slice(0, 200)}`);
    }
    for (const line of body.logLines ?? []) printLogLine(io, path, line);
    if (!res.ok || body.status !== "success") {
      const message = (body.errorMessage ?? body.message ?? `${res.status}`).trim();
      const list = message.includes("Could not find function")
        ? `\n\n${await availableFunctions(target, componentPath)}`
        : "";
      throw new RunFailure(`Failed to run function "${rawName}":\n${message}${list}`);
    }
    if (body.value !== null && body.value !== undefined)
      io.out(
        io.isTTY
          ? Bun.inspect(fromJsonValue(body.value), { colors: true, depth: Number.POSITIVE_INFINITY })
          : JSON.stringify(body.value, null, 2),
      );
    return 0;
  } catch (e) {
    io.err(e instanceof RunFailure ? e.message : `✖ ${(e as Error).message}`);
    return 1;
  } finally {
    await acquired.release();
  }
}
