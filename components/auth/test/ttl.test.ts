// The lifetimes' resolution and checks (STUDY-208 §1.2), upstream's `lib/ttl.test.ts` at v2.0.0, ported.
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_ACCESS_TOKEN_TTL_SECONDS,
  DEFAULT_SESSION_MAX_LIFETIME_SECONDS,
  resolveTtlConfig,
} from "../src/lib/ttl.ts";

describe("resolveTtlConfig", () => {
  test("fills in every default when given nothing", () => {
    expect(resolveTtlConfig({})).toEqual({
      accessTokenTtlSeconds: DEFAULT_ACCESS_TOKEN_TTL_SECONDS,
      refreshInactivityTimeoutSeconds: DEFAULT_SESSION_MAX_LIFETIME_SECONDS,
      sessionMaxLifetimeSeconds: DEFAULT_SESSION_MAX_LIFETIME_SECONDS,
    });
    expect([DEFAULT_ACCESS_TOKEN_TTL_SECONDS, DEFAULT_SESSION_MAX_LIFETIME_SECONDS]).toEqual([60, 30 * 24 * 60 * 60]);
  });

  test("keeps the values the app sets", () => {
    const set = {
      accessTokenTtlSeconds: 300,
      refreshInactivityTimeoutSeconds: 60 * 60,
      sessionMaxLifetimeSeconds: 2 * 60 * 60,
    };
    expect(resolveTtlConfig(set)).toEqual(set);
  });

  test("defaults the inactivity timeout to the app's max lifetime", () => {
    expect(resolveTtlConfig({ sessionMaxLifetimeSeconds: 60 * 60 }).refreshInactivityTimeoutSeconds).toBe(60 * 60);
  });

  test("rejects an inactivity timeout longer than the default max lifetime", () => {
    expect(() =>
      resolveTtlConfig({ refreshInactivityTimeoutSeconds: 2 * DEFAULT_SESSION_MAX_LIFETIME_SECONDS }),
    ).toThrow("Refresh inactivity timeout must be at most the session max lifetime.");
  });

  test.each([
    { accessTokenTtlSeconds: Number.NaN },
    { refreshInactivityTimeoutSeconds: Number.NaN },
    { sessionMaxLifetimeSeconds: Number.NaN },
    { sessionMaxLifetimeSeconds: Number.POSITIVE_INFINITY },
  ])("rejects a non-finite lifetime: %o", (args) => {
    expect(() => resolveTtlConfig(args)).toThrow("Token and session lifetimes must be finite numbers.");
  });

  // Beyond upstream: the remaining checks, in v2's order, and that only the three fields come back.
  test("checks positivity, then the hour, then the access token against the timeout", () => {
    expect(() => resolveTtlConfig({ accessTokenTtlSeconds: 0, sessionMaxLifetimeSeconds: -1 })).toThrow(
      "Token and session lifetimes must be positive.",
    );
    expect(() => resolveTtlConfig({ accessTokenTtlSeconds: 3601, refreshInactivityTimeoutSeconds: 3000 })).toThrow(
      "Access-token TTL must be at most one hour (the deployment refuses to sign a longer-lived JWT).",
    );
    expect(() => resolveTtlConfig({ accessTokenTtlSeconds: 600, refreshInactivityTimeoutSeconds: 600 })).toThrow(
      "Access-token TTL must be shorter than the refresh inactivity timeout.",
    );
    expect(resolveTtlConfig({ refreshTokenTtlSeconds: 5 } as never)).toEqual(resolveTtlConfig({}));
  });
});
