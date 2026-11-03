// The cross-site request check of the session's routes (STUDY-202 §1.4), v2's `ssr/origin.ts` in bunvex's words. A
// browser sends the cookies with a cross-site POST too (SameSite=Lax lets top-level navigations through), so each route
// refuses a request whose `Origin` is not the app's own before it reads a cookie or calls the deployment.
import type { AuthSessionResponse } from "../lib/types.ts";

// An allowed origin's host: a URL's, or the entry itself when it is not a URL (`app.example.com:8443`).
function hostOf(origin: string): string {
  if (!origin.includes("://")) return origin;
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

/**
 * Whether a request comes from the app's own pages: its `Origin` names the request's `Host` (with the port), or one of
 * `allowedOrigins` (for a proxy that rewrites `Host`). A request without an `Origin`, or with `null` (a sandboxed
 * iframe, a privacy-preserving redirect), is refused.
 */
export function isTrustedOrigin(request: Request, allowedOrigins: string[] = []): boolean {
  const origin = request.headers.get("origin");
  if (!origin || origin === "null") return false;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  if (originHost === request.headers.get("host")) return true;
  return allowedOrigins.some((allowed) => hostOf(allowed) === originHost);
}

/** The answer to a refused origin: 403, no session. */
export function forbiddenOriginResponse(): Response {
  return Response.json({ tokens: null } satisfies AuthSessionResponse, { status: 403 });
}
