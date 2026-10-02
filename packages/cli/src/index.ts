// Package @bunvex/cli — the bunvex command line. Today: `admin-key` (STUDY-34), `deploy` (STUDY-35), `codegen` (STUDY-36), `env`, `run` and `dev` (STUDY-37, STUDY-40), `export` and `import` (STUDY-42), `data` (STUDY-43).
import { adminKeyCommand } from "./admin-key.ts";
import { codegenCommand } from "./codegen-command.ts";
import { dataCommand } from "./data.ts";
import { deployCommand } from "./deploy.ts";
import { devCommand } from "./dev.ts";
import { envCommand } from "./env.ts";
import { exportCommand } from "./export.ts";
import { importCommand } from "./import.ts";
import { type Io, processIo } from "./io.ts";
import { runCommand } from "./run.ts";

export type { Io } from "./io.ts";

const USAGE = `Usage: bunvex <command> [options]

Commands:
  admin-key   print an admin key for this deployment
  codegen     generate the functions directory's _generated/ (api, server, dataModel)
  data        list the tables, or print a table's documents
  deploy      bundle the functions and push them to a deployment
  dev         push the functions, and again whenever they change
  env         set and view the deployment's environment variables
  export      export the deployment's data into a ZIP file
  import      import data from a file (CSV, JSON, JSON Lines, or a snapshot ZIP) into the deployment
  run         run a function (query, mutation or action) on the deployment

Run \`bunvex <command> --help\` for a command's options, \`bunvex --version\` for the version.`;

const COMMANDS: Record<string, (args: string[], io: Io) => Promise<number>> = {
  "admin-key": adminKeyCommand,
  codegen: codegenCommand,
  data: dataCommand,
  deploy: deployCommand,
  dev: (args, io) => devCommand(args, io),
  env: envCommand,
  export: (args, io) => exportCommand(args, io),
  import: (args, io) => importCommand(args, io),
  run: runCommand,
};

// The version: the standalone executable's (set at build, STUDY-39), else the package's.
declare const BUNVEX_BUILD_VERSION: string | undefined;
export const VERSION: string =
  typeof BUNVEX_BUILD_VERSION === "string" ? BUNVEX_BUILD_VERSION : (await import("../package.json")).version;

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
