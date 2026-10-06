// `bunvex mcp start` (STUDY-121): a Model Context Protocol server over stdio, as Convex's `npx convex mcp start`
// (npm-packages/convex/src/cli/mcp.ts, lib/mcp/*). The official MCP SDK serves it; each tool's input is a zod
// schema (its JSON Schema listed by `tools/list`); a call answers `{content: [{type: "text", text:
// JSON.stringify(result)}]}`, or the same with `{error: message}` and `isError`. Calls run one at a time.
//
// bunvex's choices (owner, 2026-10-05): no `insights` tool (DV-392); the deployment is reached with its URL and
// admin key, with no cloud login (DV-393); the server's name is bunvex's (DV-394); a self-hosted deployment is
// "production" for the guards, a local deployment is not (DV-395).
import { Server } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import type { Io } from "./io.ts";
import { MCP_TOOLS, type McpContext, McpToolError, TOOL_NAMES } from "./mcp-tools.ts";
import { TARGET_OPTIONS, takeTargetFlags } from "./target.ts";

/** Convex's tool that bunvex does not have; `--disable-tools insights` is accepted and does nothing (DV-392). */
const ABSENT_TOOLS = ["insights"];

export const MCP_USAGE = `Usage: bunvex mcp start [options]

Start the Model Context Protocol server for bunvex, for AI tools: it speaks MCP on stdin and stdout.

Options:
  --project-dir <dir>  run the server for a single project (by default each tool call names its project
                       directory)
  --disable-tools <names>
                       comma separated list of tools to disable (options: ${TOOL_NAMES.join(", ")})
  --cautiously-allow-production-pii
                       allow the read-only tools that may expose PII (data, logs, runOneoffQuery) on a
                       production (self-hosted) deployment
  --dangerously-enable-production-deployments
                       DANGEROUSLY allow every tool, mutating ones included, on a production (self-hosted)
                       deployment
${TARGET_OPTIONS}`;

type Parsed = Omit<McpContext, "env" | "err"> & { disableTools?: string };

function parse(args: string[]): Parsed | string {
  const taken = takeTargetFlags(args);
  if (typeof taken === "string") return taken;
  const o: Parsed = {
    flags: taken.flags,
    cautiouslyAllowProductionPii: false,
    dangerouslyEnableProductionDeployments: false,
  };
  let disableProduction = false;
  const r = taken.rest;
  for (let i = 0; i < r.length; i++) {
    const a = r[i]!;
    const [name, inline] = a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a, undefined];
    if (name === "--project-dir" || name === "--disable-tools") {
      const v = inline ?? r[++i];
      if (v === undefined) return `${name} needs a value`;
      if (name === "--project-dir") o.projectDir = v;
      else o.disableTools = v;
    } else if (a === "--cautiously-allow-production-pii") o.cautiouslyAllowProductionPii = true;
    else if (a === "--dangerously-enable-production-deployments") o.dangerouslyEnableProductionDeployments = true;
    // Convex's deprecated flag, now the default: hidden, a no-op.
    else if (a === "--disable-production-deployments") disableProduction = true;
    else return `unknown option ${a}`;
  }
  if (disableProduction && o.dangerouslyEnableProductionDeployments)
    return "option '--disable-production-deployments' cannot be used with option '--dangerously-enable-production-deployments'";
  return o;
}

/** The tools left after `--disable-tools`, by name; throws Convex's error for a name it does not know. */
export function enabledTools(disableTools: string | undefined) {
  const disabled = new Set<string>();
  for (const raw of disableTools?.split(",") ?? []) {
    const name = raw.trim();
    if (!TOOL_NAMES.includes(name) && !ABSENT_TOOLS.includes(name))
      throw new Error(`Disabled tool ${name} not found (valid tools: ${TOOL_NAMES.join(", ")})`);
    disabled.add(name);
  }
  return new Map(MCP_TOOLS.filter((t) => !disabled.has(t.name)).map((t) => [t.name, t]));
}

/** One server (the SDK asks the factory once per connection). */
export function makeServer(ctx: McpContext, disableTools: string | undefined) {
  const tools = enabledTools(disableTools);
  // Calls run one after another, as Convex's (its handlers change the working directory).
  let queue: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  };
  const server = new Server({ name: "Bunvex MCP Server", version: "0.0.1" }, { capabilities: { tools: {} } });
  server.setRequestHandler("tools/call", async (request) => {
    try {
      if (!request.params.arguments) throw new McpToolError("No arguments provided");
      const tool = tools.get(request.params.name);
      if (!tool) throw new McpToolError(`Tool ${request.params.name} not found`);
      const input = tool.inputSchema.parse(request.params.arguments);
      const result = await exclusive(() => tool.handler(ctx, input as never));
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }], isError: true };
    }
  });
  server.setRequestHandler("tools/list", async () => ({
    tools: [...tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: z.toJSONSchema(t.inputSchema, { target: "draft-7" }) as never,
    })),
  }));
  return server;
}

export async function mcpCommand(args: string[], io: Io): Promise<number> {
  if (args.includes("--help") || args.includes("-h") || args[0] !== "start") {
    if (args[0] !== "start" && !args.includes("--help") && !args.includes("-h")) {
      io.err(`bunvex mcp: expected \`start\`\n\n${MCP_USAGE}`);
      return 2;
    }
    io.out(MCP_USAGE);
    return 0;
  }
  const o = parse(args.slice(1));
  if (typeof o === "string") {
    io.err(`bunvex mcp start: ${o}\n\n${MCP_USAGE}`);
    return 2;
  }
  // The SDK calls the factory only once a client connects, so a bad `--disable-tools` is refused here.
  try {
    enabledTools(o.disableTools);
  } catch (e) {
    io.err(`Failed to start MCP server: ${String(e)}`);
    return 1;
  }
  const { disableTools, ...rest } = o;
  // stdout carries the protocol: everything else goes to stderr.
  const ctx: McpContext = { ...rest, env: io.env, err: io.err };
  serveStdio(() => makeServer(ctx, disableTools), {
    legacy: "serve",
    onerror: (error) => io.err(`MCP server error: ${error.message}`),
  });
  // Served until the client closes stdin or ends the process.
  return await new Promise<number>(() => {});
}
