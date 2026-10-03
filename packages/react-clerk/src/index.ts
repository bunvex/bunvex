// Package @bunvex/react-clerk — the React client authenticated with Clerk (STUDY-47), the counterpart of
// Convex's `convex/react-clerk` (`ConvexProviderWithClerk`): Clerk's `useAuth` turned into the
// `{isLoading, isAuthenticated, fetchAccessToken}` that `BunvexProviderWithAuth` takes.
import { BunvexProviderWithAuth } from "@bunvex/react";
import { createElement, type ReactNode, useCallback, useMemo } from "react";

type AuthClient = Parameters<typeof BunvexProviderWithAuth>[0]["client"];

/**
 * What the provider reads from Clerk's `useAuth` (`@clerk/clerk-react`, `@clerk/react`, `@clerk/nextjs`,
 * `@clerk/clerk-expo`, …). Only `isLoaded`, `isSignedIn` and `getToken` are used; a change of organization,
 * role or session makes a new token fetcher, so the client authenticates again.
 */
export type UseClerkAuth = () => {
  isLoaded: boolean;
  isSignedIn: boolean | undefined;
  getToken: (options: { template?: "bunvex"; skipCache?: boolean }) => Promise<string | null>;
  orgId: string | undefined | null;
  orgRole: string | undefined | null;
  sessionId: string | undefined | null;
  sessionClaims: Record<string, unknown> | undefined | null;
};

/**
 * `BunvexProvider` authenticated with Clerk. It must be under Clerk's provider, and takes that library's
 * `useAuth`. The token is the session token when Clerk's integration already gives it `aud: "bunvex"`,
 * else one from the JWT template named "bunvex" (DV-242).
 */
export function BunvexProviderWithClerk({
  children,
  client,
  useAuth,
}: {
  children?: ReactNode;
  client: AuthClient;
  useAuth: UseClerkAuth;
}) {
  const useAuthFromClerk = useMemo(() => fromClerk(useAuth), [useAuth]);
  return createElement(BunvexProviderWithAuth, { client, useAuth: useAuthFromClerk }, children);
}

function fromClerk(useClerkAuth: UseClerkAuth) {
  return function useAuthFromClerk() {
    const { isLoaded, isSignedIn, getToken, orgId, orgRole, sessionId, sessionClaims } = useClerkAuth();
    // A new fetcher (so a new `setAuth`) when the organization, role or session changes. `getToken` and
    // `sessionClaims` are left out, as Convex: Clerk's Expo hook returns a new `getToken` on every render.
    // biome-ignore lint/correctness/useExhaustiveDependencies: these dependencies are the point, see above
    const fetchAccessToken = useCallback(
      async ({ forceRefreshToken }: { forceRefreshToken: boolean }) => {
        try {
          return sessionClaims?.aud === "bunvex"
            ? await getToken({ skipCache: forceRefreshToken })
            : await getToken({ template: "bunvex", skipCache: forceRefreshToken });
        } catch {
          return null;
        }
      },
      [orgId, orgRole, sessionId],
    );
    return useMemo(
      () => ({ isLoading: !isLoaded, isAuthenticated: isSignedIn ?? false, fetchAccessToken }),
      [isLoaded, isSignedIn, fetchAccessToken],
    );
  };
}
