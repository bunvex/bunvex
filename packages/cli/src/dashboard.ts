// `bunvex dashboard` (`dash`, STUDY-146, STUDY-149 PR 7): Convex's `npx convex dashboard`
// (npm-packages/convex/src/cli/dashboard.ts) for the deployments bunvex has. A self-hosted deployment: Convex says
// the command does not support it (the CLI knows of no dashboard for it) and exits 0. A local deployment: the
// dashboard `dev` runs beside it (local-dashboard.ts), opened in the browser (or its URL printed, `--no-open`) once
// its `/api/current_deployment` names this deployment; otherwise Convex's warning. `bunvex dashboard serve` serves
// the app itself (dashboard-serve.ts).
import { argumentError } from "./args.ts";
import { openInBrowser } from "./browser.ts";
import { dashboardServeCommand } from "./dashboard-serve.ts";
import { parseNoArguments } from "./docs.ts";
import type { Io } from "./io.ts";
import { isLocalDashboardRunning, localDashboardUrl, readDashboardUnavailable } from "./local-dashboard.ts";
import { configuredDeployment } from "./local-deployment.ts";
import { NO_DEPLOYMENT, resolveTarget, TARGET_OPTIONS, takeTargetFlags } from "./target.ts";

export const DASHBOARD_USAGE = `Usage: bunvex dashboard|dash [options] [command]

Open the dashboard in the browser

Options:
  --no-open            Don't automatically open the dashboard in the default browser
${TARGET_OPTIONS}

Commands:
  serve [options]      serve the dashboard app over HTTP (\`bunvex dashboard serve --help\`)`;

export async function dashboardCommand(args: string[], io: Io, opts: { signal?: AbortSignal } = {}): Promise<number> {
  if (args[0] === "serve") return dashboardServeCommand(args.slice(1), io, opts);
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
    const configured = configuredDeployment(io, taken.flags);
    if (configured?.type === "local") {
      // `dev` running without the dashboard, which it could not download (DV-486)
      const unavailable = readDashboardUnavailable(io.cwd);
      if (unavailable !== null) {
        io.err(
          `\`bunvex dev\` is running without the local dashboard: it could not be downloaded (${unavailable}). Restart \`bunvex dev\` once it can be.`,
        );
        return 0;
      }
      const url = localDashboardUrl(io.cwd);
      if (url === null || !(await isLocalDashboardRunning(url, configured.name))) {
        io.err("You are not currently running the dashboard locally. Make sure `bunvex dev` is running and try again.");
        return 0;
      }
      if (!flags.open) {
        io.out(url);
        return 0;
      }
      io.err(`Opening ${url} in the default browser...`);
      try {
        await (io.open ?? openInBrowser)(url);
      } catch {
        // Convex's: a headless machine cannot open it
        io.err(`⚠️ Could not open dashboard in the default browser.\nPlease visit: ${url}`);
      }
      return 0;
    }
  } catch (e) {
    io.err(`bunvex dashboard: ${(e as Error).message}`);
    return 1;
  }
  io.err(`bunvex dashboard: ${NO_DEPLOYMENT}`);
  return 1;
}
