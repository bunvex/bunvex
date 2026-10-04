// Credentials from the page that embeds the dashboard in an iframe, as Convex's self-hosted dashboard takes
// them (`_app.tsx`, `useEmbeddedDashboardCredentials`): on load it asks its parent with
// `{ type: "dashboard-credentials-request" }`, and signs in with a `{ type: "dashboard-credentials",
// adminKey, deploymentUrl, deploymentName }` message.
//
// Unlike Convex, which asks with target "*" and accepts the answer from any origin, bunvex asks and listens
// only at the parent origins the deployment's operator allowed (STUDY-12 LG3, DV-319). With no list, embedded
// sign-in is off: nothing is asked and every answer is ignored (fail closed).
import { type AdminCredentials, normalizeDeploymentUrl } from "./credentials.ts";

/** The `<meta name>` in index.html that carries the allowed parent origins (filled at build, editable after). */
export const EMBED_ORIGINS_META = "bunvex-embed-origins";

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

/**
 * The allowed parent origins from their configured form: origins separated by commas or spaces
 * (`https://admin.example.com, http://localhost:3000`). Each is reduced to its origin (scheme, host, port);
 * anything that is not an http(s) URL is dropped (`*` included), so a typo never widens the list.
 */
export function parseAllowedOrigins(raw: string | null | undefined): string[] {
  const origins = new Set<string>();
  for (const entry of (raw ?? "").split(/[\s,]+/)) {
    if (!entry) continue;
    try {
      const u = new URL(entry);
      if (u.protocol === "http:" || u.protocol === "https:") origins.add(u.origin);
    } catch {
      // not a URL: ignored
    }
  }
  return [...origins];
}

/** Reads the allowed parent origins from the page's `<meta name="bunvex-embed-origins">`. */
export function readAllowedOrigins(doc: Pick<Document, "querySelector">): string[] {
  return parseAllowedOrigins(doc.querySelector(`meta[name="${EMBED_ORIGINS_META}"]`)?.getAttribute("content"));
}

/**
 * Asks the parent window for credentials and calls `onCredentials` with each valid answer that the parent
 * sends from one of `allowedOrigins`. With no allowed origin it does nothing. Returns a stop.
 */
export function listenForEmbeddedCredentials(
  win: Pick<Window, "parent" | "addEventListener" | "removeEventListener">,
  allowedOrigins: readonly string[],
  onCredentials: (c: AdminCredentials) => void,
): () => void {
  if (allowedOrigins.length === 0) return () => {};
  const onMessage = (e: MessageEvent) => {
    if (!allowedOrigins.includes(e.origin) || e.source !== win.parent) return;
    const c = parseEmbeddedCredentials(e.data);
    if (c) onCredentials(c);
  };
  win.addEventListener("message", onMessage as EventListener);
  // ask after listening, so an answer can't arrive before anyone hears it; the request is addressed to each
  // allowed origin (never "*"): it is delivered only if the parent is at that origin (browsers drop the
  // others; some environments throw, which changes nothing)
  if (win.parent && win.parent !== (win as unknown))
    for (const origin of allowedOrigins)
      try {
        win.parent.postMessage({ type: "dashboard-credentials-request" }, origin);
      } catch {
        // the parent is at another origin
      }
  return () => win.removeEventListener("message", onMessage as EventListener);
}
