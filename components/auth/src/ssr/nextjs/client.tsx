// The client provider under Next.js (STUDY-202 §1.8), v2's `ssr/nextjs/client.tsx` in bunvex's names (C-4): the
// session's `AuthClient` in its server-rendering model, where an httpOnly cookie holds the refresh token. Refresh and
// sign-out post to the app's routes; sign-ins go through the sign-in route with an HTTP client pointed at it, so the
// methods' usual hooks work unchanged.
"use client";

import { BunvexHttpClient } from "@bunvex/client";
import { BunvexProviderWithAuth, BunvexReactClient } from "@bunvex/react";
import { makeFunctionReference } from "@bunvex/server";
import { type ReactNode, useMemo } from "react";
import type { AmbientSignInClient, AuthSignInApi } from "../../browser/ambientSignInClient.ts";
import { AuthClient } from "../../browser/sessionManager.ts";
import { defaultStorage, type TokenStorage } from "../../browser/storage.ts";
import type { AuthSessionResponse, IsAuthenticatedFn } from "../../lib/types.ts";
import { oauth } from "../../methods/oauth/client.ts";
import { AuthProvider, SessionWatcher, useAuth } from "../../react/client.tsx";

// A route's answer; one that is not JSON is no session.
async function postAuth(route: string): Promise<AuthSessionResponse> {
  const response = await fetch(route, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  return (await response.json().catch(() => ({ tokens: null }))) as AuthSessionResponse;
}

/**
 * The session's client provider under Next.js, in place of `BunvexProvider`. `BunvexAuthNextjsServerProvider` renders it
 * with the token it read; render it yourself to pass your own client or routes.
 */
export function BunvexAuthNextjsProvider({
  client,
  bunvexUrl,
  initialToken = null,
  refreshRoute = "/auth/refresh",
  signOutRoute = "/auth/signout",
  signInRoute = "/auth/signin",
  storage,
  ambientSignIns,
  isAuthenticatedFunctionName,
  children,
}: {
  /** Your `BunvexReactClient`; one is made for `bunvexUrl` otherwise. */
  client?: BunvexReactClient;
  /** The deployment's URL, when no `client` is given (`NEXT_PUBLIC_BUNVEX_URL` by default). */
  bunvexUrl?: string;
  /** The access token the server read, so the first render is signed in. */
  initialToken?: string | null;
  /** The refresh route (`/auth/refresh`). */
  refreshRoute?: string;
  /** The sign-out route (`/auth/signout`). */
  signOutRoute?: string;
  /** The sign-in route (`/auth/signin`). */
  signInRoute?: string;
  /** Where the access token is kept in the browser: `localStorage` by default. */
  storage?: TokenStorage;
  /**
   * Advanced. Sign-ins that start on their own (an OAuth callback's code in the URL); it replaces the default,
   * `[oauth()]`. Read once, when the client is made.
   */
  ambientSignIns?: AmbientSignInClient[];
  /**
   * The name of the app's `isAuthenticated` query (`BunvexAuthNextjsServerProvider` passes it: a function reference
   * does not survive the trip from the server to the client, its name does). The provider subscribes to it, so a
   * session revoked on the server signs the browser out at once.
   */
  isAuthenticatedFunctionName: string;
  children: ReactNode;
}) {
  // The client's identity is what counts; the other props are read once.
  // biome-ignore lint/correctness/useExhaustiveDependencies: as above
  const { authClient, bunvex, signInApi } = useMemo(() => {
    const bunvex = client ?? new BunvexReactClient(bunvexUrl ?? process.env.NEXT_PUBLIC_BUNVEX_URL!);
    // Sign-ins go to the sign-in route, which moves the refresh token into its cookie. The route speaks the HTTP
    // client's wire, so this is a real client whose address is the route: arguments and errors keep their encoding.
    // The address is relative (hence no URL check), a same-origin fetch sends the cookies, and `?path=` puts the
    // endpoint the client appends into the query string, so the route is one static path.
    const proxy = new BunvexHttpClient(`${signInRoute}?path=`, { skipDeploymentUrlCheck: true, logger: bunvex.logger });
    // Each call carries the current access token, if any: a sign-in may link to the signed-in user. The client and the
    // API refer to each other (the ambient sign-ins are set up while the client is made), so the token is read lazily.
    let authClient: AuthClient | undefined;
    const withAuth = () => {
      const token = authClient?.getAccessToken() ?? null;
      if (token !== null) proxy.setAuth(token);
      else proxy.clearAuth();
      return proxy;
    };
    const signInApi: AuthSignInApi = {
      mutation: (fn, args) => withAuth().mutation(fn, args),
      // The HTTP client's `action` takes its arguments as an optional rest; the API always has them.
      action: (fn, args) => withAuth().action(fn, ...([args] as [never])),
    };
    authClient = new AuthClient({
      mode: "ssr",
      authApi: {
        // The route reads the refresh token from its cookie.
        refreshSession: async () => (await postAuth(refreshRoute)).tokens,
        signOut: async () => {
          await postAuth(signOutRoute);
        },
      },
      storage: storage ?? defaultStorage(),
      storageNamespace: bunvex.url,
      // The server may have refreshed for this page: the freshest token, adopted at `init()`.
      initialAccessToken: initialToken,
      ambientSignIns: {
        signIns: ambientSignIns ?? [oauth()],
        signInApi,
        // Calls that return no sign-in result (starting an OAuth flow) go to the deployment: the route refuses them.
        bunvex: { mutation: (fn, args) => bunvex.mutation(fn, args) },
        // Next's router keeps its own copy of the URL and writes it back on its next update. It patches
        // `replaceState` to follow, but skips calls that carry its own history state, and on the first mount patches
        // it only after this runs. So: replace now, then again on the next tick with no state, which it follows.
        replaceUrl: (url) => {
          window.history.replaceState(window.history.state, "", url);
          setTimeout(() => window.history.replaceState(null, "", window.location.href));
        },
      },
    });
    return { authClient, bunvex, signInApi };
  }, [client, bunvexUrl]);

  const isAuthenticated = useMemo(
    () => makeFunctionReference(isAuthenticatedFunctionName) as IsAuthenticatedFn,
    [isAuthenticatedFunctionName],
  );

  return (
    <AuthProvider authClient={authClient} signInApi={signInApi}>
      <BunvexProviderWithAuth client={bunvex} useAuth={useAuth}>
        <SessionWatcher isAuthenticated={isAuthenticated} />
        {children}
      </BunvexProviderWithAuth>
    </AuthProvider>
  );
}
