// Token and session lifetimes (STUDY-208 §1.2), v2.0.0's `lib/ttl.ts`: the defaults, the resolution of the app's
// options (`setupAuth`, when the app's modules load) and the checks, in v2's order and with its messages. The core's
// functions take the three values as required arguments and check them again, with no defaults of their own.
import { v } from "@bunvex/values";

/** The access token's lifetime when the app sets none, in seconds: a minute. */
export const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 60;
/** A session's longest life when the app sets none, in seconds: 30 days. */
export const DEFAULT_SESSION_MAX_LIFETIME_SECONDS = 30 * 24 * 60 * 60;

// `ctx.auth.signJwt` signs nothing that lives longer: a longer access token is a misconfiguration.
const MAX_ACCESS_TOKEN_TTL_SECONDS = 60 * 60;

/**
 * The lifetimes of the tokens and sessions. A session ends at the sooner of two deadlines:
 *
 * - `refreshInactivityTimeoutSeconds` after its last refresh (when its newest refresh token was issued): each refresh
 *   moves it later;
 * - `sessionMaxLifetimeSeconds` after the session was created, however often it refreshes.
 */
export type TtlConfig = {
  accessTokenTtlSeconds: number;
  refreshInactivityTimeoutSeconds: number;
  sessionMaxLifetimeSeconds: number;
};

/** The three lifetimes as a component function's arguments: all required. */
export const vTtlConfigFields = {
  accessTokenTtlSeconds: v.number(),
  refreshInactivityTimeoutSeconds: v.number(),
  sessionMaxLifetimeSeconds: v.number(),
};

/**
 * The lifetimes from the app's options, with the defaults for those it leaves out, checked. The inactivity timeout
 * defaults to the max lifetime (the app's, or the default): a session's newest token is never older than the session,
 * so at that default only the max lifetime ends a session. Throws for invalid values.
 */
export function resolveTtlConfig(args: {
  accessTokenTtlSeconds?: number;
  refreshInactivityTimeoutSeconds?: number;
  sessionMaxLifetimeSeconds?: number;
}): TtlConfig {
  const sessionMaxLifetimeSeconds = args.sessionMaxLifetimeSeconds ?? DEFAULT_SESSION_MAX_LIFETIME_SECONDS;
  return validateTtlConfig({
    accessTokenTtlSeconds: args.accessTokenTtlSeconds ?? DEFAULT_ACCESS_TOKEN_TTL_SECONDS,
    refreshInactivityTimeoutSeconds: args.refreshInactivityTimeoutSeconds ?? sessionMaxLifetimeSeconds,
    sessionMaxLifetimeSeconds,
  });
}

/** Check a complete set of lifetimes and return it (the three fields only). Throws at the first rule broken. */
export function validateTtlConfig(ttl: TtlConfig): TtlConfig {
  const { accessTokenTtlSeconds, refreshInactivityTimeoutSeconds, sessionMaxLifetimeSeconds } = ttl;
  // First: every comparison with `NaN` is false, so the checks below would let it through.
  if (
    !Number.isFinite(accessTokenTtlSeconds) ||
    !Number.isFinite(refreshInactivityTimeoutSeconds) ||
    !Number.isFinite(sessionMaxLifetimeSeconds)
  )
    throw new Error("Token and session lifetimes must be finite numbers.");
  if (accessTokenTtlSeconds <= 0 || refreshInactivityTimeoutSeconds <= 0 || sessionMaxLifetimeSeconds <= 0)
    throw new Error("Token and session lifetimes must be positive.");
  if (accessTokenTtlSeconds > MAX_ACCESS_TOKEN_TTL_SECONDS)
    throw new Error("Access-token TTL must be at most one hour (the deployment refuses to sign a longer-lived JWT).");
  if (accessTokenTtlSeconds >= refreshInactivityTimeoutSeconds)
    throw new Error("Access-token TTL must be shorter than the refresh inactivity timeout.");
  // With the check above, the access token is shorter than the max lifetime too. Equal is accepted.
  if (refreshInactivityTimeoutSeconds > sessionMaxLifetimeSeconds)
    throw new Error("Refresh inactivity timeout must be at most the session max lifetime.");
  return { accessTokenTtlSeconds, refreshInactivityTimeoutSeconds, sessionMaxLifetimeSeconds };
}
