// Signing the dashboard in to a deployment (STUDY-12 §19): a deployment URL and an admin key, checked by a
// verifier before the screens open — as Convex's self-hosted dashboard does (`checkDeploymentInfo.ts`:
// `GET /api/check_admin_key` with `Authorization: Convex <key>` → `{ allowedOps, isReadOnly }`). Only the mock
// verifier exists for now: the dashboard does not talk to a real server yet (the owner's call, 2 Oct 2026).
import type { Capabilities, Operation } from "@bunvex/dashboard/data-source";

/** What a sign-in carries. */
export type AdminCredentials = { deploymentUrl: string; adminKey: string; deploymentName?: string };

/** What the deployment says about a key: which operations it allows (none listed = all), and read-only. */
export type AdminKeyCheck = { ok: true; allowedOps: string[]; isReadOnly: boolean } | { ok: false; error: string };

/** Checks a key against a deployment. The real one calls `check_admin_key`; for now only the mock exists. */
export interface AdminKeyVerifier {
  verify(deploymentUrl: string, adminKey: string): Promise<AdminKeyCheck>;
}

export const INVALID_CREDENTIALS =
  "The deployment URL or admin key is invalid. Check that you entered the correct values.";

/**
 * A deployment URL as typed, made canonical (`http(s)://host[:port][/path]`, no trailing slash), or why not.
 * A bare host gets `http://` for a local address and `https://` otherwise.
 */
export function normalizeDeploymentUrl(input: string): { ok: true; url: string } | { ok: false; error: string } {
  const text = input.trim();
  if (text === "") return { ok: false, error: "Enter the deployment URL." };
  const local = /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:|\/|$)/.test(text);
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `${local ? "http" : "https"}://${text}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false, error: "This is not a URL. For example: http://127.0.0.1:3210" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    return { ok: false, error: "The URL must start with http:// or https://." };
  if (url.search || url.hash) return { ok: false, error: "The URL can't have a query or a fragment." };
  return { ok: true, url: `${url.origin}${url.pathname.replace(/\/+$/, "")}` };
}

// The server's operation names (Convex's keybroker `DeploymentOp`) → the dashboard's.
const SERVER_OPS: Record<string, Operation> = {
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
  check: { allowedOps: string[]; isReadOnly: boolean },
  all: readonly Operation[],
): Capabilities {
  const operations =
    check.allowedOps.length === 0
      ? [...all]
      : [...new Set(check.allowedOps.flatMap((op) => (SERVER_OPS[op] ? [SERVER_OPS[op]] : [])))];
  return { operations, readOnly: check.isReadOnly };
}

/**
 * The mock verifier, so the sign-in can be tried without a server. A key is Convex-shaped, `<name>|<secret>`:
 * a secret starting with `readonly` gives a read-only key, `viewer` one that may only view data and logs;
 * anything without `|` is refused, as an unknown key would be.
 */
export function mockVerifier(delayMs = 300): AdminKeyVerifier {
  return {
    async verify(deploymentUrl, adminKey) {
      await new Promise((r) => setTimeout(r, delayMs));
      const [name, secret] = adminKey.trim().split("|", 2);
      if (!normalizeDeploymentUrl(deploymentUrl).ok || !name || !secret)
        return { ok: false, error: INVALID_CREDENTIALS };
      if (secret.startsWith("readonly")) return { ok: true, allowedOps: [], isReadOnly: true };
      if (secret.startsWith("viewer")) return { ok: true, allowedOps: ["ViewData", "ViewLogs"], isReadOnly: true };
      return { ok: true, allowedOps: [], isReadOnly: false };
    },
  };
}

/** The deployment's name as the key carries it (`<name>|…`), for the header. */
export const deploymentNameOf = (adminKey: string) => adminKey.split("|", 1)[0]?.trim() || undefined;
