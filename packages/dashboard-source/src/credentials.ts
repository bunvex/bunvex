// Signing the dashboard in to a deployment (STUDY-12 §19, STUDY-149 §1.4): a deployment URL and an admin key,
// checked before the screens open, as Convex's self-hosted dashboard does
// (`dashboard-self-hosted/src/lib/checkDeploymentInfo.ts`): `GET /api/check_admin_key` with the key, up to 3
// tries 500 ms apart; a 404 (a server without the route) allows every operation. This module does not import
// the sync client, so a host can use it without pulling the client into its bundle.
import type { Capabilities, Operation } from "@bunvex/dashboard/data-source";
import { adminHeaders, type FetchFn, joinUrl } from "./admin-http.ts";

/** What a sign-in carries. */
export type AdminCredentials = { deploymentUrl: string; adminKey: string; deploymentName?: string };

/** What the deployment says about a key: which operations it allows (none listed = all), and read-only. */
export type AdminKeyCheck = { ok: true; allowedOps: string[]; isReadOnly: boolean } | { ok: false; error: string };

/** Checks a key against a deployment. */
export interface AdminKeyVerifier {
  verify(deploymentUrl: string, adminKey: string): Promise<AdminKeyCheck>;
}

/** What a failed sign-in says (Convex's self-hosted dashboard: "The deployment URL or admin key is invalid…"). */
export const INVALID_CREDENTIALS =
  "The deployment URL or admin key is invalid. Check that you entered the correct values.";

/** Convex's `MAX_RETRIES` and `MAX_RETRIES_DELAY_MS`. */
export const CHECK_TRIES = 3;
export const CHECK_RETRY_DELAY_MS = 500;

export type AdminKeyVerifierOptions = {
  /** Default: the global `fetch`. */
  fetch?: FetchFn;
  /** Default: 500 ms, as Convex. Tests shorten it. */
  retryDelayMs?: number;
};

/**
 * The verifier over `GET <url>/api/check_admin_key`, as Convex's `checkDeploymentInfo`: a 2xx gives the key's
 * `allowedOps` and `isReadOnly` (an answer that is not JSON allows everything), a 404 allows everything, and
 * anything else — a refused key, a network error — is tried again, 3 times in all with 500 ms after each, then
 * refused. Convex's dashboard never says why; neither does this.
 */
export function createAdminKeyVerifier(opts: AdminKeyVerifierOptions = {}): AdminKeyVerifier {
  const fetchFn = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const delayMs = opts.retryDelayMs ?? CHECK_RETRY_DELAY_MS;
  return {
    async verify(deploymentUrl, adminKey) {
      for (let tries = 0; tries < CHECK_TRIES; tries++) {
        try {
          const res = await fetchFn(joinUrl(deploymentUrl, "/api/check_admin_key"), {
            method: "GET",
            headers: { "Content-Type": "application/json", ...adminHeaders(adminKey) },
          });
          if (res.ok) {
            try {
              const body = (await res.json()) as { allowedOps?: string[]; isReadOnly?: boolean };
              return { ok: true, allowedOps: body.allowedOps ?? [], isReadOnly: body.isReadOnly ?? false };
            } catch {
              return { ok: true, allowedOps: [], isReadOnly: false };
            }
          }
          if (res.status === 404) return { ok: true, allowedOps: [], isReadOnly: false };
        } catch {
          // a network error: tried again, as any other failure
        }
        await new Promise((r) => setTimeout(r, delayMs));
      }
      return { ok: false, error: INVALID_CREDENTIALS };
    },
  };
}

/** The server's operation names (Convex's keybroker `DeploymentOp`) → the dashboard's. */
export const SERVER_OPS: Readonly<Record<string, Operation>> = {
  ViewData: "viewData",
  WriteData: "writeData",
  ViewLogs: "viewLogs",
  ViewMetrics: "viewMetrics",
  ViewEnvironmentVariables: "viewEnvironmentVariables",
  WriteEnvironmentVariables: "writeEnvironmentVariables",
  ViewAuditLog: "viewAuditLog",
  PauseDeployment: "pauseDeployment",
  UnpauseDeployment: "resumeDeployment",
  ActAsUser: "actAsUser",
  ViewBackups: "viewBackups",
  CreateBackups: "createBackups",
  DownloadBackups: "downloadBackups",
  ImportBackups: "importBackups",
  // running functions from the dashboard: Convex gates internal functions and test queries
  RunInternalQueries: "runFunctions",
  RunInternalMutations: "runFunctions",
  RunInternalActions: "runFunctions",
  RunTestQuery: "runFunctions",
};

/** The dashboard's capabilities for a checked key. An empty `allowedOps` means every operation (Convex). */
export function capabilitiesOf(
  check: { allowedOps: readonly string[]; isReadOnly: boolean },
  all: readonly Operation[],
): Capabilities {
  const operations =
    check.allowedOps.length === 0
      ? [...all]
      : [...new Set(check.allowedOps.flatMap((op) => (SERVER_OPS[op] ? [SERVER_OPS[op]] : [])))];
  return { operations, readOnly: check.isReadOnly };
}
