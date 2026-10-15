// The CLI's dashboard links (STUDY-149 PR 8, DV-477). Convex's CLI links its dashboard from several places
// (npm-packages/convex/src/cli/lib/dashboard.ts `deploymentDashboardUrlPage`, called from convexExport.ts,
// convexImport.ts, lib/components.ts, lib/deploy2.ts, lib/indexes.ts, lib/config.ts, lib/init.ts and the MCP
// `status` tool), always to `dashboard.convex.dev/d/<name><page>` — wrong for a local or self-hosted deployment, as
// its own FIXME says. bunvex links the dashboard it serves: the local one `bunvex dev` runs beside a local
// deployment, while it runs and names this deployment; otherwise no link (a self-hosted deployment never has one:
// the CLI does not know where its dashboard is, and Convex's CLI has no setting for it either).

import type { Io } from "./io.ts";
import { isLocalDashboardRunning, localDashboardUrl } from "./local-dashboard.ts";
import { configuredDeployment, readLocalConfig } from "./local-deployment.ts";
import { resolveTarget, type TargetFlags } from "./target.ts";

/** The dashboard's root URL (`http://127.0.0.1:<port>/`), or null when there is none to link; asked once. */
export type DashboardLink = () => Promise<string | null>;

export const NO_DASHBOARD: DashboardLink = async () => null;

/** The link to a dashboard known to be serving at `url` (`bunvex dev`'s own). */
export const servedDashboard =
  (url: string): DashboardLink =>
  async () =>
    url;

/**
 * For a command run in a project: its local deployment's dashboard, if `bunvex dev` is serving it now (the saved
 * port answers `/api/current_deployment` with this deployment, as `bunvex dashboard` checks); none for a
 * deployment given by URL. Resolved at the first ask, so a command that prints no link asks nothing.
 */
export function localDashboardLink(io: Io, flags: TargetFlags = {}): DashboardLink {
  let found: Promise<string | null> | undefined;
  return () => {
    found ??= (async () => {
      try {
        if (resolveTarget(flags, io)) return null;
        if (configuredDeployment(io, flags)?.type !== "local") return null;
      } catch {
        return null;
      }
      const config = readLocalConfig(io.cwd);
      const url = localDashboardUrl(io.cwd);
      if (!config || url === null) return null;
      return (await isLocalDashboardRunning(url, config.deploymentName)) ? url : null;
    })();
    return found;
  };
}

/**
 * The URL of one of the dashboard's pages, Convex's pages mapped to bunvex's routes: `settings/snapshots`
 * (Convex's too), `database/<table>?panel=indexes` (Convex's `data?table=<table>&showIndexes=true`), `schema`
 * (`schema?showSchema=true`), `settings/environment-variables` (with `?var=<name>`, Convex's too).
 */
export async function dashboardPage(link: DashboardLink, page: string): Promise<string | null> {
  const root = await link();
  return root === null ? null : `${root}${page}`;
}

/** Settings → Snapshots, where Convex links an export's and an import's progress. */
export const SNAPSHOTS_PAGE = "settings/snapshots";

/** Settings → Environment variables, where Convex sends a push refused for a variable its auth config needs. */
export const ENV_VARS_PAGE = "settings/environment-variables";

/** That page with a new row for `name` to fill in, as Convex links it (`?var=<name>`). */
export const envVarPage = (name: string) => `${ENV_VARS_PAGE}?var=${encodeURIComponent(name)}`;

/** A table's indexes on the Database screen, where Convex links a staged index's backfill progress. */
export const tableIndexesPage = (table: string) => `database/${encodeURIComponent(table)}?panel=indexes`;
