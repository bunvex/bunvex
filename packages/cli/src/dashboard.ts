// `bunvex dashboard` (`dash`, STUDY-146): Convex's `npx convex dashboard` (npm-packages/convex/src/cli/dashboard.ts)
// for the deployments bunvex has. A self-hosted deployment: Convex says the command does not support it (the CLI
// knows of no dashboard for it) and exits 0. A local deployment: Convex opens the dashboard `dev` runs beside it,
// and warns when there is none; bunvex has none (DV-202), so it warns. Neither opens a browser.
import { argumentError } from "./args.ts";
import { parseNoArguments } from "./docs.ts";
import type { Io } from "./io.ts";
import { configuredDeployment } from "./local-deployment.ts";
import { NO_DEPLOYMENT, resolveTarget, TARGET_OPTIONS, takeTargetFlags } from "./target.ts";

export const DASHBOARD_USAGE = `Usage: bunvex dashboard|dash [options]

Open the dashboard in the browser

Options:
  --no-open            Don't automatically open the dashboard in the default browser
${TARGET_OPTIONS}`;

export async function dashboardCommand(args: string[], io: Io): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    io.out(DASHBOARD_USAGE);
    return 0;
  }
  // Convex's `dashboard` shows its help after an argument error.
  const taken = takeTargetFlags(args);
  if (typeof taken === "string") return argumentError(io, taken, DASHBOARD_USAGE);
  const flags = parseNoArguments(taken.rest, io, {
    command: "dashboard",
    usage: DASHBOARD_USAGE,
    noOpen: true,
    helpAfterError: true,
  });
  if (typeof flags === "number") return flags;
  try {
    if (resolveTarget(taken.flags, io)) {
      io.err(
        "Self-hosted deployment configured.\n`bunvex dashboard` is not supported for self-hosted deployments.\nSee self-hosting instructions for how to self-host the dashboard.",
      );
      return 0;
    }
    if (configuredDeployment(io, taken.flags)?.type === "local") {
      io.err("You are not currently running the dashboard locally. Make sure `bunvex dev` is running and try again.");
      return 0;
    }
  } catch (e) {
    io.err(`bunvex dashboard: ${(e as Error).message}`);
    return 1;
  }
  io.err(`bunvex dashboard: ${NO_DEPLOYMENT}`);
  return 1;
}
