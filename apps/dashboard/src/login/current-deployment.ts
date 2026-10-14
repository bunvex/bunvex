// The credentials of the deployment the dashboard was served for (STUDY-149 §1.4, §3.3), as Convex's self-hosted
// dashboard reads them (`fetchCurrentDeployment.ts`) in a build made for the CLI's local dashboard
// (`NEXT_PUBLIC_USE_CURRENT_DEPLOYMENT_API`; here `VITE_BUNVEX_USE_CURRENT_DEPLOYMENT=1`): `GET
// /api/current_deployment` on the dashboard's own origin answers `{ name, url, adminKey }`, and the dashboard
// signs in with them. Anything else — a 404 (a server that does not offer it), a network error, another shape —
// is null, and the sign-in page is shown. The server side is the local dashboard's (STUDY-149 PR 7, with its
// `Host` check, DV-476).
import type { AdminCredentials } from "./credentials.ts";

export const CURRENT_DEPLOYMENT_PATH = "/api/current_deployment";

/** `{ name, url, adminKey }`, each a string and `url` an http(s) URL; otherwise null. */
export function parseCurrentDeployment(body: unknown): AdminCredentials | null {
  if (typeof body !== "object" || body === null) return null;
  const { name, url, adminKey } = body as Record<string, unknown>;
  if (typeof name !== "string" || typeof url !== "string" || typeof adminKey !== "string") return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  } catch {
    return null;
  }
  return { deploymentUrl: url, adminKey, deploymentName: name };
}

/** Asks the dashboard's own server for the current deployment's credentials; null when it has none. */
export async function fetchCurrentDeployment(
  fetchFn: (input: string) => Promise<Response> = (input) => fetch(input),
): Promise<AdminCredentials | null> {
  try {
    const res = await fetchFn(CURRENT_DEPLOYMENT_PATH);
    return res.ok ? parseCurrentDeployment(await res.json()) : null;
  } catch {
    return null;
  }
}
