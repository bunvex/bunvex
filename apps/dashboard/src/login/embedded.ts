// Credentials from the page that embeds the dashboard in an iframe, as Convex's self-hosted dashboard takes
// them (`_app.tsx`, `useEmbeddedDashboardCredentials`): on load it asks its parent with
// `{ type: "dashboard-credentials-request" }`, and signs in with a `{ type: "dashboard-credentials",
// adminKey, deploymentUrl, deploymentName }` message. Like Convex, any origin may answer (STUDY-12 §19, LG3).
import { type AdminCredentials, normalizeDeploymentUrl } from "./credentials.ts";

export function parseEmbeddedCredentials(data: unknown): AdminCredentials | null {
  if (typeof data !== "object" || data === null) return null;
  const d = data as Record<string, unknown>;
  if (d.type !== "dashboard-credentials") return null;
  if (typeof d.adminKey !== "string" || typeof d.deploymentUrl !== "string" || typeof d.deploymentName !== "string")
    return null;
  const url = normalizeDeploymentUrl(d.deploymentUrl);
  if (!url.ok || !/^https?:\/\//.test(d.deploymentUrl)) return null;
  return { adminKey: d.adminKey, deploymentUrl: url.url, deploymentName: d.deploymentName };
}

/** Asks the parent window for credentials and calls `onCredentials` with each valid answer. Returns a stop. */
export function listenForEmbeddedCredentials(
  win: Pick<Window, "parent" | "addEventListener" | "removeEventListener">,
  onCredentials: (c: AdminCredentials) => void,
): () => void {
  const onMessage = (e: MessageEvent) => {
    const c = parseEmbeddedCredentials(e.data);
    if (c) onCredentials(c);
  };
  win.addEventListener("message", onMessage as EventListener);
  // ask after listening, so an answer can't arrive before anyone hears it
  if (win.parent && win.parent !== (win as unknown))
    win.parent.postMessage({ type: "dashboard-credentials-request" }, "*");
  return () => win.removeEventListener("message", onMessage as EventListener);
}
