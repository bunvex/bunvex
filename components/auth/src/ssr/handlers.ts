// The session's refresh and sign-out routes (STUDY-202 §1.4), v2's `ssr/handlers.ts` in bunvex's words: WHATWG
// `(Request) => Response` handlers an app mounts on its own server. Each reads the httpOnly refresh-token cookie and
// answers with what the page may hold, the access token alone; each refuses a cross-site request first. Sign-in has no
// handler here: every method goes through the sign-in proxy (`signInProxy.ts`).
import { BunvexHttpClient } from "@bunvex/client";
import type { AuthSessionResponse, RefreshSessionFn, SignOutFn } from "../lib/types.ts";
import { makeSlimBundle } from "../lib/types.ts";
import { AUTH_REFRESH_COOKIE, type AuthCookieOptions, clearAuthCookies } from "./cookies.ts";
import { httpCookies } from "./httpCookies.ts";
import { forbiddenOriginResponse, isTrustedOrigin } from "./origin.ts";
import { ServerAuthSession } from "./session.ts";

/** A WHATWG request handler. */
export type RequestHandler = (request: Request) => Promise<Response>;

/** What {@link refreshHandler} needs. */
export interface RefreshHandlerConfig {
  /** The deployment's URL, as the server reaches it. */
  bunvexUrl: string;
  /** The app's `refreshSession` mutation. */
  refreshSession: RefreshSessionFn;
  /** The session cookies' attributes. */
  cookieOptions: AuthCookieOptions;
  /** Origins trusted besides the request's own `Host` (see {@link isTrustedOrigin}). */
  allowedOrigins?: string[];
}

/**
 * The refresh route: the refresh-token cookie exchanged for new tokens, both cookies rewritten, and the access token in
 * the answer, as `{ tokens }`. Without a session (no cookie, or one the deployment no longer knows) it answers 401 with
 * `tokens: null`, and clears the cookies.
 */
export function refreshHandler(config: RefreshHandlerConfig): RequestHandler {
  const client = new BunvexHttpClient(config.bunvexUrl);
  return async (request) => {
    if (!isTrustedOrigin(request, config.allowedOrigins)) return forbiddenOriginResponse();
    const cookies = httpCookies(request);
    const session = new ServerAuthSession({
      refreshSession: (refreshToken) => client.mutation(config.refreshSession, { refreshToken }),
      cookies,
      cookieOptions: config.cookieOptions,
    });
    const result = await session.refresh();
    const response =
      result.kind === "noSession"
        ? Response.json({ tokens: null } satisfies AuthSessionResponse, { status: 401 })
        : Response.json({ tokens: makeSlimBundle(result.tokens) } satisfies AuthSessionResponse);
    cookies.applyTo(response.headers);
    return response;
  };
}

/** What {@link signOutHandler} needs. */
export interface SignOutHandlerConfig {
  /** The deployment's URL, as the server reaches it. */
  bunvexUrl: string;
  /** The app's `signOut` mutation. */
  signOut: SignOutFn;
  /** The session cookies' attributes. */
  cookieOptions: AuthCookieOptions;
  /** Origins trusted besides the request's own `Host` (see {@link isTrustedOrigin}). */
  allowedOrigins?: string[];
}

/**
 * The sign-out route: the refresh-token cookie's session revoked (if the deployment refuses, it was gone already) and
 * both cookies cleared; it answers `{ tokens: null }`.
 */
export function signOutHandler(config: SignOutHandlerConfig): RequestHandler {
  const client = new BunvexHttpClient(config.bunvexUrl);
  return async (request) => {
    if (!isTrustedOrigin(request, config.allowedOrigins)) return forbiddenOriginResponse();
    const cookies = httpCookies(request);
    const refreshToken = (await cookies.get(AUTH_REFRESH_COOKIE)) ?? null;
    if (refreshToken !== null) {
      try {
        await client.mutation(config.signOut, { refreshToken });
      } catch {
        // Signed out already, most likely: the cookies go either way.
      }
    }
    await clearAuthCookies(cookies, config.cookieOptions);
    const response = Response.json({ tokens: null } satisfies AuthSessionResponse);
    cookies.applyTo(response.headers);
    return response;
  };
}
