// The MCP server's tools (STUDY-121), as Convex's `cli/lib/mcp/tools/*`: the same names, inputs, outputs,
// guards and messages, in bunvex's words. A deployment selector (from `status`) is opaque to the client:
// `<kind>:<base64 of {projectDir, deployment: {kind}}>`. The tool reaches the deployment its project directory
// configures (`BUNVEX_SELF_HOSTED_*`, or the local deployment), with the server's `--url` / `--admin-key` /
// `--env-file` first, as every command.
import { BunvexHttpClient, type Logger, VERSION } from "@bunvex/client";
import { fromJsonValue, type JSONValue, type Value } from "@bunvex/values";
import { z } from "zod";
import { functionsDir } from "./deploy.ts";
import { runTestQuery, TestQueryRequestError } from "./inline-query.ts";
import type { Io } from "./io.ts";
import { parseJson5 } from "./json5.ts";
import { acquireTarget, configuredDeployment, readLocalConfig } from "./local-deployment.ts";
import { formatEntries, type LogEntry, NO_COLORS } from "./logs.ts";
import { parseFunctionName } from "./run.ts";
import { NO_DEPLOYMENT, resolveTarget, type Target, type TargetFlags } from "./target.ts";

/** What every call sees: the server's options, its environment, and stderr. */
export type McpContext = {
  flags: TargetFlags;
  projectDir?: string;
  cautiouslyAllowProductionPii: boolean;
  dangerouslyEnableProductionDeployments: boolean;
  env: Record<string, string | undefined>;
  err: (line: string) => void;
};

/** A tool's failure with its message (Convex's `RequestCrash`). */
export class McpToolError extends Error {}

type McpTool = {
  name: string;
  description: string;
  inputSchema: z.ZodObject;
  handler: (ctx: McpContext, input: never) => Promise<unknown>;
};
const tool = <S extends z.ZodObject>(t: {
  name: string;
  description: string;
  inputSchema: S;
  handler: (ctx: McpContext, input: z.infer<S>) => Promise<unknown>;
}): McpTool => t as unknown as McpTool;

// ---------------------------------------------------------------- deployments and their guards

type Kind = "local" | "prod";
type Selected = { kind: Kind; projectDir: string; io: Io; selfHosted: Target | null };

const ioFor = (ctx: McpContext, projectDir: string): Io => ({
  env: ctx.env,
  cwd: projectDir,
  // stdout is the protocol's.
  out: ctx.err,
  err: ctx.err,
});

/** The project's deployment: self-hosted (production for the guards, DV-395) or its local deployment. */
function select(ctx: McpContext, projectDir: string): Selected {
  const io = ioFor(ctx, projectDir);
  const selfHosted = resolveTarget(ctx.flags, io);
  if (!selfHosted && configuredDeployment(io, ctx.flags)?.type !== "local") throw new McpToolError(NO_DEPLOYMENT);
  return { kind: selfHosted ? "prod" : "local", projectDir, io, selfHosted };
}

export function encodeDeploymentSelector(projectDir: string, kind: Kind) {
  return `${kind}:${btoa(JSON.stringify({ projectDir, deployment: { kind } }))}`;
}
const selectorPayload = z.object({ projectDir: z.string(), deployment: z.object({ kind: z.string() }) });
const decodeDeploymentSelector = (encoded: string) =>
  selectorPayload.parse(JSON.parse(atob(encoded.split(":")[1] ?? ""))).projectDir;

/**
 * Convex's three guards: `checked` (mutating and function-running tools) needs
 * `--dangerously-enable-production-deployments` on production; `readOnly` (tools that may expose PII) needs
 * that or `--cautiously-allow-production-pii`; `unchecked` (schemas, function specs) needs neither.
 */
type Guard = "checked" | "readOnly" | "unchecked";
async function withDeployment<T>(
  ctx: McpContext,
  selector: string,
  guard: Guard,
  fn: (target: Target, s: Selected) => Promise<T>,
): Promise<T> {
  const s = select(ctx, decodeDeploymentSelector(selector));
  if (s.kind === "prod" && !ctx.dangerouslyEnableProductionDeployments) {
    if (guard === "checked")
      throw new McpToolError(
        "This tool cannot be used with production deployments. Use a read-only tool like `tables` instead, or enable production access with --dangerously-enable-production-deployments.",
      );
    if (guard === "readOnly" && !ctx.cautiouslyAllowProductionPii)
      throw new McpToolError(
        "This read-only tool may expose PII from production. Enable with --cautiously-allow-production-pii, or use --dangerously-enable-production-deployments for full access.",
      );
  }
  const acquired = await acquireTarget(ctx.flags, s.io);
  if (!acquired) throw new McpToolError(NO_DEPLOYMENT);
  try {
    return await fn(acquired.target, s);
  } finally {
    await acquired.release();
  }
}

// ---------------------------------------------------------------- requests

/** Convex's `ThrowingFetchError` message: `Error fetching <METHOD>  <url> <status> <text>: <code>: <message>`. */
async function fetchFailure(method: string | null, url: string, r: Response): Promise<Error> {
  let code: unknown;
  let message: unknown;
  try {
    ({ code, message } = (await r.json()) as { code?: unknown; message?: unknown });
  } catch {}
  const head = `Error fetching ${method ? `${method} ` : ""} ${url} ${r.status} ${r.statusText}`;
  return new Error(code !== undefined && message !== undefined ? `${head}: ${code}: ${message}` : head);
}

async function deploymentFetch(target: Target, path: string, method: "GET" | null = null): Promise<Response> {
  const url = `${target.url}${path}`;
  let r: Response;
  try {
    r = await fetch(url, {
      headers: { authorization: `Bunvex ${target.adminKey}`, "bunvex-client": `npm-cli-${VERSION}` },
    });
  } catch (e) {
    throw new Error(`could not reach ${target.url}: ${(e as Error).message}`);
  }
  if (!r.ok) throw await fetchFailure(method, url, r);
  return r;
}

/** A system query's value (Convex's `runSystemQuery`), as a bunvex value. */
async function systemQuery(target: Target, path: string, args: Record<string, unknown>): Promise<Value> {
  const url = `${target.url}/api/query`;
  let r: Response;
  try {
    r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bunvex ${target.adminKey}` },
      body: JSON.stringify({ path, args, format: "encoded_json" }),
    });
  } catch (e) {
    throw new Error(`could not reach ${target.url}: ${(e as Error).message}`);
  }
  if (!r.ok) throw await fetchFailure("POST", url, r);
  const body = (await r.json()) as { status: string; value?: JSONValue; errorMessage?: string };
  if (body.status !== "success") throw new Error(`Failed to run function "${path}":\n${body.errorMessage?.trim()}`);
  return fromJsonValue(body.value ?? null);
}

// ---------------------------------------------------------------- the tools

const selectorInput = (what: string) => z.string().describe(`Deployment selector (from the status tool) to ${what}.`);

const projectDirDescription = `
The root directory of the bunvex project. This is usually the editor's workspace directory
and often includes the 'package.json' file and the 'bunvex/' folder.

Pass this option unless explicitly instructed not to.
`;

const StatusTool = tool({
  name: "status",
  description: `
Get the available deployment for a given bunvex project directory.

Use this tool to find the deployment selector and URL of the deployment associated with the project.
Pass the deployment selector to other tools to target it.

A project uses either a local deployment ({"kind": "local"}) or a self-hosted one ({"kind": "prod"}), which
is treated as production.

If a deployment has "readOnly: true", it can only be used with read-only tools that don't expose PII
(\`functionSpec\`, \`tables\`). Tools that read user data (\`data\`, \`logs\`, \`runOneoffQuery\`) and mutating
tools will reject it.

If "readOnly" is false or absent, all tools can be used with the deployment.
`.trim(),
  inputSchema: z.object({ projectDir: z.string().optional().describe(projectDirDescription) }),
  handler: async (ctx, input) => {
    const projectDir = input.projectDir ?? ctx.projectDir;
    if (projectDir === undefined)
      throw new McpToolError(
        "No project directory provided. Either provide the `projectDir` argument or configure the MCP server with the `--project-dir` flag.",
      );
    const s = select(ctx, projectDir);
    const local = s.selfHosted ? null : readLocalConfig(projectDir);
    const url = s.selfHosted?.url ?? (local ? `http://127.0.0.1:${local.ports.cloud}` : null);
    if (url === null) throw new McpToolError(NO_DEPLOYMENT);
    const d: Record<string, unknown> = {
      kind: s.kind,
      deploymentSelector: encodeDeploymentSelector(projectDir, s.kind),
      url,
    };
    // Convex marks production read-only unless production access (or its PII) is allowed.
    if (s.kind === "prod" && !ctx.dangerouslyEnableProductionDeployments)
      d.readOnly = !ctx.cautiouslyAllowProductionPii;
    return { availableDeployments: [d] };
  },
});

const DataTool = tool({
  name: "data",
  description: `
Read a page of data from a table in the project's bunvex deployment.

Output:
- page: A page of results from the table.
- isDone: Whether there are more results to read.
- continueCursor: The cursor to use to read the next page of results.
`.trim(),
  inputSchema: z.object({
    deploymentSelector: selectorInput("read data from"),
    tableName: z.string().describe("The name of the table to read from."),
    order: z.enum(["asc", "desc"]).describe("The order to sort the results in."),
    cursor: z.string().optional().describe("The cursor to start reading from."),
    limit: z.number().max(1000).optional().describe("The maximum number of results to return, defaults to 100."),
  }),
  handler: async (ctx, args) =>
    withDeployment(ctx, args.deploymentSelector, "readOnly", async (target) => {
      const r = (await systemQuery(target, "_system/cli/tableData", {
        table: args.tableName,
        order: args.order,
        paginationOpts: { numItems: args.limit ?? 100, cursor: args.cursor ?? null },
      })) as { page: Value[]; isDone: boolean; continueCursor: string };
      return { page: r.page, isDone: r.isDone, continueCursor: r.continueCursor };
    }),
});

const TablesTool = tool({
  name: "tables",
  description: "List all tables in a particular bunvex deployment and their inferred and declared schema.",
  inputSchema: z.object({ deploymentSelector: selectorInput("read tables from") }),
  handler: async (ctx, args) =>
    withDeployment(ctx, args.deploymentSelector, "unchecked", async (target) => {
      const schemas = (await systemQuery(target, "_system/frontend/getSchemas", {})) as { active?: string };
      const declared: Record<string, Record<string, unknown>> = {};
      if (schemas.active) {
        const parsed = JSON.parse(schemas.active) as { tables: Record<string, unknown>[] };
        // Convex's entry: name, indexes, search and vector indexes, document type (bunvex stores no empty
        // search or vector lists).
        for (const t of parsed.tables)
          declared[t.tableName as string] = {
            tableName: t.tableName,
            indexes: t.indexes ?? [],
            searchIndexes: t.searchIndexes ?? [],
            vectorIndexes: t.vectorIndexes ?? [],
            documentType: t.documentType,
          };
      }
      const shapes = (await (await deploymentFetch(target, "/api/shapes2")).json()) as Record<string, unknown>;
      const tables: Record<string, { schema?: unknown; inferredSchema?: unknown }> = {};
      for (const name of [...new Set([...Object.keys(shapes), ...Object.keys(declared)])].sort())
        tables[name] = { schema: declared[name], inferredSchema: shapes[name] };
      return { tables };
    }),
});

const FunctionSpecTool = tool({
  name: "functionSpec",
  description: `
Get the function metadata from a bunvex deployment.

Returns an array of structured objects for each function the deployment. Each function's
metadata contains its identifier (which is its path within the bunvex/ folder joined
with its exported name), its argument validator, its return value validator, its type
(i.e. is it a query, mutation, or action), and its visibility (i.e. is it public or
internal).
`.trim(),
  inputSchema: z.object({ deploymentSelector: selectorInput("get function metadata from") }),
  handler: async (ctx, args) =>
    withDeployment(ctx, args.deploymentSelector, "unchecked", async (target) => {
      const r = await fetch(`${target.url}/api/query`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bunvex ${target.adminKey}` },
        body: JSON.stringify({ path: "_system/cli/modules:apiSpec", args: {}, format: "encoded_json" }),
      });
      if (!r.ok) throw await fetchFailure("POST", `${target.url}/api/query`, r);
      // Convex returns it as JSON (`convexToJson`): the encoded form, as it came.
      return ((await r.json()) as { value: JSONValue }).value;
    }),
});

const RunTool = tool({
  name: "run",
  description: `
Run a bunvex function (query, mutation, or action) on your deployment.

Returns the result and any log lines generated by the function.
`.trim(),
  inputSchema: z.object({
    deploymentSelector: selectorInput("run the function on"),
    functionName: z.string().describe("The name of the function to run (e.g. 'path/to/my/module.js:myFunction')."),
    args: z.string().describe("The argument object to pass to the function, JSON-encoded as a string."),
  }),
  handler: async (ctx, args) =>
    withDeployment(ctx, args.deploymentSelector, "checked", async (target, s) => {
      let parsed: Record<string, Value>;
      try {
        parsed = fromJsonValue(parseJson5(args.args) as JSONValue) as Record<string, Value>;
      } catch (e) {
        throw new McpToolError(`Failed to parse arguments as JSON: "${args.args}"\n${String(e).trim()}`);
      }
      const name = parseFunctionName(args.functionName, s.projectDir, functionsDir(s.projectDir));
      // Convex's DefaultLogger listener: `<level>: <the logger's arguments joined>`.
      const logLines: string[] = [];
      const line =
        (level: string) =>
        (...a: unknown[]) =>
          logLines.push(`${level}: ${a.join(" ")}`);
      const logger: Logger = { logVerbose: line("debug"), log: line("info"), warn: line("warn"), error: line("error") };
      const client = new BunvexHttpClient(target.url, { logger });
      client.setAdminAuth(target.adminKey);
      let result: Value;
      try {
        result = (await client.function(name, undefined, parsed as never)) as Value;
      } catch (e) {
        throw new McpToolError(`Failed to run function "${args.functionName}":\n${String(e).trim()}`);
      }
      return { result, logLines };
    }),
});

const envVar = (what: string) => z.string().describe(`The name of the environment variable to ${what}.`);
const updateEnv = async (target: Target, changes: { name: string; value: string | null }[]) => {
  const url = `${target.url}/api/update_environment_variables`;
  let r: Response;
  try {
    r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bunvex ${target.adminKey}` },
      body: JSON.stringify({ changes }),
    });
  } catch (e) {
    throw new Error(`could not reach ${target.url}: ${(e as Error).message}`);
  }
  if (!r.ok) throw await fetchFailure("POST", url, r);
};

const EnvListTool = tool({
  name: "envList",
  description: "List all environment variables in your bunvex deployment.",
  inputSchema: z.object({ deploymentSelector: selectorInput("list environment variables from") }),
  handler: async (ctx, args) =>
    withDeployment(ctx, args.deploymentSelector, "checked", async (target) => ({
      variables: await systemQuery(target, "_system/cli/queryEnvironmentVariables", {}),
    })),
});

const EnvGetTool = tool({
  name: "envGet",
  description: "Get a specific environment variable from your bunvex deployment.",
  inputSchema: z.object({
    deploymentSelector: selectorInput("get environment variable from"),
    name: envVar("retrieve"),
  }),
  handler: async (ctx, args) =>
    withDeployment(ctx, args.deploymentSelector, "checked", async (target) => {
      const v = (await systemQuery(target, "_system/cli/queryEnvironmentVariables:get", { name: args.name })) as {
        value: string;
      } | null;
      return { value: v?.value ?? null };
    }),
});

const EnvSetTool = tool({
  name: "envSet",
  description: "Set an environment variable in your bunvex deployment.",
  inputSchema: z.object({
    deploymentSelector: selectorInput("set environment variable on"),
    name: envVar("set"),
    value: z.string().describe("The value to set for the environment variable."),
  }),
  handler: async (ctx, args) =>
    withDeployment(ctx, args.deploymentSelector, "checked", async (target) => {
      await updateEnv(target, [{ name: args.name, value: args.value }]);
      return { success: true };
    }),
});

const EnvRemoveTool = tool({
  name: "envRemove",
  description: "Remove an environment variable from your bunvex deployment.",
  inputSchema: z.object({
    deploymentSelector: selectorInput("remove environment variable from"),
    name: envVar("remove"),
  }),
  handler: async (ctx, args) =>
    withDeployment(ctx, args.deploymentSelector, "checked", async (target) => {
      await updateEnv(target, [{ name: args.name, value: null }]);
      return { success: true };
    }),
});

const RunOneoffQueryTool = tool({
  name: "runOneoffQuery",
  description: `
Run a one-off readonly query on your bunvex deployment.

This tool executes a JavaScript string as a query in your bunvex deployment.
The query should follow bunvex guidelines and use the following setup:

\`\`\`js
import { query, internalQuery } from "bunvex:/_system/repl/wrappers.js";

export default query({
  handler: async (ctx) => {
    console.log("Write and test your query function here!");
  },
});
\`\`\`

Note that there are no imports available in this environment. The only import
you can use is the built-in "bunvex:/_system/repl/wrappers.js" module in the
template.

The function call is also completely sandboxed, so it can only read data and
cannot modify the database or access the network.

Returns the result and any log lines generated by the query.
`.trim(),
  inputSchema: z.object({
    deploymentSelector: selectorInput("run the query on"),
    query: z
      .string()
      .describe(
        'JavaScript module source for a single file (testQuery.js) that exports a default readonly query, for example: export default query({ handler: async (ctx) => ({ count: (await ctx.db.query("messages").take(10)).length }) });',
      ),
  }),
  handler: async (ctx, args) =>
    withDeployment(ctx, args.deploymentSelector, "readOnly", async (target) => {
      let outcome: Awaited<ReturnType<typeof runTestQuery>>;
      try {
        outcome = await runTestQuery(target, args.query);
      } catch (e) {
        if (e instanceof TestQueryRequestError) throw new McpToolError(e.message);
        throw new McpToolError(`Failed to run query: ${String(e).trim()}`);
      }
      if (outcome.kind === "failure")
        throw new McpToolError(`Query failed: ${JSON.stringify(outcome.payload, null, 2)}`);
      return { result: outcome.value, logLines: outcome.logLines };
    }),
});

/** Convex's `limitLogs`: the last `entriesLimit` entries, then as many as fit about `tokensLimit` tokens. */
export function limitLogs(entries: unknown[], tokensLimit: number, entriesLimit: number): unknown[] {
  const kept: unknown[] = [];
  let tokens = 0;
  for (const e of entries.slice(entries.length - entriesLimit)) {
    // Convex's estimate: a third of a token per character of the entry's JSON.
    tokens += JSON.stringify(e).length * 0.33;
    if (tokens > tokensLimit) break;
    kept.push(e);
  }
  return kept;
}

const LogsTool = tool({
  name: "logs",
  description: `
Fetch a chunk of recent log entries from your bunvex deployment.

Returns a batch of UDF execution log entries and a new cursor you can use to
request the next batch. This tool does not tail; it performs a single fetch.

To see only errors and exceptions, set status to "failure". This filters to
executions where a function threw an error, which is useful for debugging
deployment issues. Each failed entry includes the error message and stack trace.
`.trim(),
  inputSchema: z.object({
    deploymentSelector: selectorInput("read logs from"),
    status: z
      .enum(["all", "success", "failure"])
      .default("all")
      .optional()
      .describe(
        'Filter by execution outcome. "failure" returns only executions that threw an error. "success" returns only successful executions. Defaults to "all".',
      ),
    cursor: z
      .number()
      .optional()
      .describe("Optional cursor (in ms) to start reading from. Use 0 to read from the beginning."),
    entriesLimit: z
      .number()
      .int()
      .positive()
      .max(1000)
      .optional()
      .describe(
        "Maximum number of log entries to return (from the end). If omitted, returns all available in this chunk.",
      ),
    tokensLimit: z
      .number()
      .int()
      .positive()
      .default(20000)
      .optional()
      .describe("Approximate maximum number of tokens to return (applied to the JSON payload). Defaults to 20000."),
    jsonl: z
      .boolean()
      .default(false)
      .optional()
      .describe("If true, return raw log entries as JSONL. If false (default), return formatted text logs."),
  }),
  handler: async (ctx, args) =>
    withDeployment(ctx, args.deploymentSelector, "readOnly", async (target) => {
      const r = await deploymentFetch(target, `/api/stream_function_logs?cursor=${args.cursor ?? 0}`, "GET");
      const body = (await r.json()) as { entries: LogEntry[]; newCursor: number };
      const status = args.status ?? "all";
      const entries =
        status === "all"
          ? body.entries
          : body.entries.filter((e) => {
              if (e.kind !== "Completion") return false;
              const failed = e.error !== undefined && e.error !== null;
              return status === "failure" ? failed : !failed;
            });
      const limited = limitLogs(entries, args.tokensLimit ?? 20000, args.entriesLimit ?? entries.length) as LogEntry[];
      if (args.jsonl) return { entries: limited.map((e) => JSON.stringify(e)).join("\n"), newCursor: body.newCursor };
      return {
        entries: formatEntries(limited, { success: false, colors: NO_COLORS }).join("\n"),
        newCursor: body.newCursor,
      };
    }),
});

/** Convex's tools, in its order, without `insights` (DV-392). */
export const MCP_TOOLS: McpTool[] = [
  StatusTool,
  DataTool,
  TablesTool,
  FunctionSpecTool,
  RunTool,
  EnvListTool,
  EnvGetTool,
  EnvSetTool,
  EnvRemoveTool,
  RunOneoffQueryTool,
  LogsTool,
];
export const TOOL_NAMES = MCP_TOOLS.map((t) => t.name).sort();
