// When refresh tokens and sessions expire (STUDY-208 §1.3), v2.0.0's `component/expiry.ts`: derived from the rows'
// `_creationTime` under the lifetimes of the call, never stored, so a changed lifetime applies to every token and
// session already there.
import type { Doc } from "./_generated/dataModel.ts";

/** When a refresh token stops refreshing its session for lack of use, under the given inactivity timeout. */
export function refreshTokenInactivityExpiresAt(
  token: Pick<Doc<"refreshTokens">, "_creationTime">,
  refreshInactivityTimeoutSeconds: number,
): number {
  return token._creationTime + refreshInactivityTimeoutSeconds * 1000;
}

/** When a session reaches its max lifetime. */
export function sessionMaxLifetimeExpiresAt(
  session: Pick<Doc<"sessions">, "_creationTime">,
  sessionMaxLifetimeSeconds: number,
): number {
  return session._creationTime + sessionMaxLifetimeSeconds * 1000;
}
