// Package @bunvex/cli — the bunvex command line. Today: `admin-key` (STUDY-34), `deploy` (STUDY-35); dev, run, codegen
// and import/export follow (roadmap Phase 3 items 7–9).
import { adminKeyCommand } from "./admin-key.ts";
import { deployCommand } from "./deploy.ts";
import { type Io, processIo } from "./io.ts";

export type { Io } from "./io.ts";

const USAGE = `Usage: bunvex <command> [options]

Commands:
  admin-key   print an admin key for this deployment
  deploy      bundle the functions and push them to a deployment

Run \`bunvex <command> --help\` for a command's options.`;

const COMMANDS: Record<string, (args: string[], io: Io) => Promise<number>> = {
  "admin-key": adminKeyCommand,
  deploy: deployCommand,
};

/** Run the command line; resolves to the exit code. */
export async function main(argv: string[], io: Io = processIo()): Promise<number> {
  const [command, ...args] = argv;
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
