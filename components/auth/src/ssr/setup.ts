// The session's routes configured once (STUDY-202 §1.4), v2's `ssr/setup.ts` in bunvex's words: one config, one set of
// cookie attributes (so `secure` is decided once and reaches sign-in too), three handlers to mount.
import type { RefreshSessionFn, SignOutFn } from "../lib/types.ts";
import type { AuthCookieOptions } from "./cookies.ts";
import { refreshHandler, signOutHandler } from "./handlers.ts";
import { bunvexProxyHandler, type ExposedSignInFn } from "./signInProxy.ts";

/** What {@link setupBunvexAuthServer} needs. */
export interface BunvexAuthServerConfig {
  /** The deployment's URL, as the server reaches it. */
  bunvexUrl: string;
  /** The app's `refreshSession` mutation. */
  refreshSession: RefreshSessionFn;
  /** The app's `signOut` mutation. */
  signOut: SignOutFn;
  /**
   * Every function of the app that signs a user in (creates a session and returns its tokens: an account's creation, a
   * sign-in with one). The sign-in route refuses any other, so this list is all it serves, and listing a function is
   * all the wiring a method needs.
   */
  signIn: ExposedSignInFn[];
  /** The session cookies' attributes, for every route; `secure` is required. */
  cookieOptions: AuthCookieOptions;
  /** Origins every route trusts besides the request's own `Host`, for a proxy that rewrites it. */
  allowedOrigins?: string[];
}

/**
 * Configure the session's routes once, and get the handlers to mount:
 *
 * ```ts
 * // auth.ts
 * export const auth = setupBunvexAuthServer({
 *   bunvexUrl: process.env.NEXT_PUBLIC_BUNVEX_URL!,
 *   refreshSession: api.auth.refreshSession,
 *   signOut: api.auth.signOut,
 *   signIn: [api.auth.signInWithUsernamePassword, api.auth.signUpWithUsernamePassword],
 *   cookieOptions: { secure: process.env.NODE_ENV === "production" },
 * });
 *
 * // app/auth/signin/route.ts
 * export const POST = auth.bunvexProxyHandler;
 * ```
 */
export function setupBunvexAuthServer(config: BunvexAuthServerConfig) {
  const { bunvexUrl, cookieOptions, allowedOrigins } = config;
  return {
    /** The refresh route (`POST`, `/auth/refresh` by default on the client). */
    refreshHandler: refreshHandler({ bunvexUrl, refreshSession: config.refreshSession, cookieOptions, allowedOrigins }),
    /** The sign-out route (`POST`, `/auth/signout` by default on the client). */
    signOutHandler: signOutHandler({ bunvexUrl, signOut: config.signOut, cookieOptions, allowedOrigins }),
    /** The sign-in route (`POST`, `/auth/signin` by default on the client), serving every function in `signIn`. */
    bunvexProxyHandler: bunvexProxyHandler({ bunvexUrl, signIn: config.signIn, cookieOptions, allowedOrigins }),
  };
}
