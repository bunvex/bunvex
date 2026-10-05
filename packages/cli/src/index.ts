// Package @bunvex/cli — the bunvex command line. Today: `admin-key` (STUDY-34), `deploy` (STUDY-35), `codegen` (STUDY-36), `env`, `run` and `dev` (STUDY-37, STUDY-40), `export` and `import` (STUDY-42), `data` (STUDY-43), `logs` (STUDY-47), `typecheck` (STUDY-117), `deployment usage` / `usage-limits` (STUDY-118), `mcp` (STUDY-121).
import { adminKeyCommand } from "./admin-key.ts";
import { codegenCommand } from "./codegen-command.ts";
import { dataCommand } from "./data.ts";
import { deployCommand } from "./deploy.ts";
import { deploymentCommand } from "./deployment.ts";
import { devCommand } from "./dev.ts";
import { envCommand } from "./env.ts";
import { exportCommand } from "./export.ts";
import { functionSpecCommand } from "./function-spec.ts";
import { importCommand } from "./import.ts";
import { type Io, processIo } from "./io.ts";
import { logsCommand } from "./logs.ts";
import { mcpCommand } from "./mcp.ts";
import { runCommand } from "./run.ts";
import { typecheckCommand } from "./typecheck.ts";
import { VERSION } from "./version.ts";

export type { Io } from "./io.ts";

const USAGE = `Usage: bunvex <command> [options]

Commands:
  admin-key   print an admin key for this deployment
  codegen     generate the functions directory's _generated/ (api, server, dataModel)
  data        list the tables, or print a table's documents
  deploy      bundle the functions and push them to a deployment
  deployment  the deployment's usage and usage limits (usage, usage-limits list|set|remove)
  dev         push the functions, and again whenever they change
  env         set and view the deployment's environment variables
  export      export the deployment's data into a ZIP file
  function-spec  list the functions' arguments and return values, as JSON
  import      import data from a file (CSV, JSON, JSON Lines, or a snapshot ZIP) into the deployment
  logs        watch the deployment's function logs
  mcp         start the Model Context Protocol server, for AI tools (\`mcp start\`)
  run         run a function (query, mutation or action) on the deployment
  typecheck   typecheck the functions with the app's TypeScript compiler (tsc or tsgo)

Run \`bunvex <command> --help\` for a command's options, \`bunvex --version\` for the version.`;

const COMMANDS: Record<string, (args: string[], io: Io) => Promise<number>> = {
  "admin-key": adminKeyCommand,
  codegen: codegenCommand,
  data: dataCommand,
  deploy: deployCommand,
  deployment: deploymentCommand,
  dev: (args, io) => devCommand(args, io),
  env: envCommand,
  export: (args, io) => exportCommand(args, io),
  "function-spec": (args, io) => functionSpecCommand(args, io),
  import: (args, io) => importCommand(args, io),
  logs: (args, io) => logsCommand(args, io),
  mcp: mcpCommand,
  run: runCommand,
  typecheck: typecheckCommand,
};

export { VERSION };

/** Run the command line; resolves to the exit code. */
export async function main(argv: string[], io: Io = processIo()): Promise<number> {
  const [command, ...args] = argv;
  if (command === "--version" || command === "-V" || command === "version") {
    io.out(`bunvex ${VERSION}`);
    return 0;
  }
  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    io.out(USAGE);
    return command === undefined ? 2 : 0;
  }
  const run = COMMANDS[command];
  if (!run) {
    io.err(`bunvex: unknown command ${command}\n\n${USAGE}`);
    return 2;
  }
  return run(args, io);
}
