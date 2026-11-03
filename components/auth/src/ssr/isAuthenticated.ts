// Whether a request is signed in, on the app's server (STUDY-202 §1.6), v2's `ssr/isAuthenticated.ts`: the access token
// is decoded only to skip a call when it has expired; otherwise the deployment answers, through the app's
// `isAuthenticated` query, which checks the signature and that the session is live. A forged or revoked cookie fails.
import { BunvexHttpClient } from "@bunvex/client";
import type { IsAuthenticatedFn } from "../lib/types.ts";
import { isTokenExpiring } from "./jwt.ts";

/** What {@link createServerAuthChecker} needs. */
export interface ServerAuthCheckerConfig {
  /** The deployment's URL, as the server reaches it. */
  bunvexUrl: string;
  /** The app's `isAuthenticated` query. */
  isAuthenticated: IsAuthenticatedFn;
}

/** Whether an access token (or none) names a live session. */
export type ServerAuthChecker = (accessToken: string | null) => Promise<boolean>;

/**
 * A check of access tokens against the deployment. No token, or an expired one, is `false` without a call; an error
 * (the deployment unreachable, the token refused) is `false` too.
 */
export function createServerAuthChecker(config: ServerAuthCheckerConfig): ServerAuthChecker {
  return async (accessToken) => {
    if (accessToken === null || isTokenExpiring(accessToken, 0)) return false;
    const client = new BunvexHttpClient(config.bunvexUrl);
    client.setAuth(accessToken);
    try {
      return await client.query(config.isAuthenticated, {});
    } catch {
      return false;
    }
  };
}
