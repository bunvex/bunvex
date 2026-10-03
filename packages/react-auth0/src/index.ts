// Package @bunvex/react-auth0 — the React client authenticated with Auth0 (STUDY-54), the counterpart of
// Convex's `convex/react-auth0` (`ConvexProviderWithAuth0`): `useAuth0` turned into the
// `{isLoading, isAuthenticated, fetchAccessToken}` that `BunvexProviderWithAuth` takes.
import { useAuth0 } from "@auth0/auth0-react";
import { BunvexProviderWithAuth } from "@bunvex/react";
import { createElement, type ReactNode, useCallback, useMemo } from "react";

type AuthClient = Parameters<typeof BunvexProviderWithAuth>[0]["client"];

/**
 * `BunvexProvider` authenticated with Auth0. It must be under a configured `Auth0Provider`. The token is the
 * ID token, read from the cache unless the client asks for a fresh one.
 */
export function BunvexProviderWithAuth0({ children, client }: { children?: ReactNode; client: AuthClient }) {
  return createElement(BunvexProviderWithAuth, { client, useAuth: useAuthFromAuth0 }, children);
}

function useAuthFromAuth0() {
  const { isLoading, isAuthenticated, getAccessTokenSilently } = useAuth0();
  const fetchAccessToken = useCallback(
    async ({ forceRefreshToken }: { forceRefreshToken: boolean }) => {
      try {
        const tokens = await getAccessTokenSilently({
          detailedResponse: true,
          cacheMode: forceRefreshToken ? "off" : "on",
        });
        return tokens?.id_token ?? null;
      } catch {
        return null;
      }
    },
    [getAccessTokenSilently],
  );
  return useMemo(
    () => ({ isLoading, isAuthenticated, fetchAccessToken }),
    [isLoading, isAuthenticated, fetchAccessToken],
  );
}
