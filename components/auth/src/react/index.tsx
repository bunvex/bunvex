// `@bunvex/auth/react` (STUDY-201 §1.11), v2's `./react` in bunvex's words (C-4: `ConvexAuthProvider` is
// `BunvexAuthProvider`, `ConvexAuthApi` `AuthApi`). The provider owns the session's lifecycle (keeping it, refreshing the
// access token, signing out) and gives `BunvexProviderWithAuth` its `useAuth`. Sign-in methods are not part of it: each
// ships its own hooks returning a session, which they hand to `useAuthActions().setSession`.
"use client";

import { BunvexHttpClient } from "@bunvex/client";
import { BunvexProviderWithAuth, type BunvexReactClient } from "@bunvex/react";
import { type ReactNode, useContext, useMemo } from "react";
import type { AmbientSignInClient, AuthSignInApi } from "../browser/ambientSignInClient.ts";
import { AuthClient } from "../browser/sessionManager.ts";
import { defaultStorage, type TokenStorage } from "../browser/storage.ts";
import type { AuthApi } from "../lib/types.ts";
import { oauth } from "../methods/oauth/client.ts";
import { AuthActionsContext, AuthProvider, AuthTokenContext, SessionWatcher, useAuth } from "./client.tsx";

export type { TokenStorage } from "../browser/storage.ts";
export type { AuthApi, TokenBundle } from "../lib/types.ts";
export type { AuthActionsContextType } from "./client.tsx";

/**
 * Put this in place of your `BunvexProvider` to sign users in.
 *
 * ```tsx
 * import { BunvexAuthProvider } from "@bunvex/auth/react";
 * import { BunvexReactClient } from "@bunvex/react";
 * import { api } from "../bunvex/_generated/api";
 *
 * const bunvex = new BunvexReactClient(import.meta.env.VITE_BUNVEX_URL);
 *
 * function Root({ children }: { children: React.ReactNode }) {
 *   return (
 *     <BunvexAuthProvider
 *       client={bunvex}
 *       api={{
 *         refreshSession: api.auth.refreshSession,
 *         signOut: api.auth.signOut,
 *         isAuthenticated: api.auth.isAuthenticated,
 *       }}
 *     >
 *       {children}
 *     </BunvexAuthProvider>
 *   );
 * }
 * ```
 */
export function BunvexAuthProvider({
  client,
  api,
  storage,
  storageNamespace,
  ambientSignIns,
  children,
}: {
  /** Your `BunvexReactClient`. */
  client: BunvexReactClient;
  /**
   * Your app's `refreshSession` and `signOut` mutations, and its `isAuthenticated` query. The provider subscribes to
   * `isAuthenticated`, so a session revoked on the server signs the client out at once.
   */
  api: AuthApi;
  /**
   * Where the tokens are kept: `localStorage` in a browser by default, memory where there is none (server rendering).
   * Give one where there is no `localStorage` (React Native), or users are signed out each time the app closes; with
   * Expo, for instance:
   *
   * ```ts
   * import * as SecureStore from "expo-secure-store";
   *
   * const secureStorage = {
   *   getItem: SecureStore.getItemAsync,
   *   setItem: SecureStore.setItemAsync,
   *   removeItem: SecureStore.deleteItemAsync,
   * };
   * ```
   */
  storage?: TokenStorage;
  /**
   * The storage keys' namespace, which decides whether clients share a session; only its letters and digits count. Your
   * deployment's URL by default.
   */
  storageNamespace?: string;
  /**
   * Advanced. Sign-ins that start on their own, outside a flow the user started (reading an OAuth callback's code from
   * the URL). It replaces the default, `[oauth()]`, entirely: pass `[]` for none, or include `oauth()` yourself to keep
   * it beside others. Read once, when the client is made.
   */
  ambientSignIns?: AmbientSignInClient[];
  children: ReactNode;
}) {
  // The client's identity is what counts; the other props are read once, when it is made.
  // biome-ignore lint/correctness/useExhaustiveDependencies: as above
  const { authClient, signInApi } = useMemo(() => {
    // Refresh and sign-out go over an HTTP client of their own: a refresh happens while `client`'s socket waits for a
    // token, so through `client` it would wait on itself.
    const http = new BunvexHttpClient(client.url, { logger: client.logger });
    // Sign-ins go over the app's socket client (not paused before authentication), so the answer carries the full
    // tokens for `setSession`; the same object serves the setups and, through `AuthProvider`, the methods' hooks.
    const signInApi: AuthSignInApi = {
      mutation: (fn, args) => client.mutation(fn, args),
      action: (fn, args) => client.action(fn, args),
    };
    const authClient = new AuthClient({
      mode: "spa",
      authApi: {
        refreshSession: (refreshToken) => http.mutation(api.refreshSession, { refreshToken }),
        signOut: async (refreshToken) => {
          await http.mutation(api.signOut, { refreshToken });
        },
      },
      storage: storage ?? defaultStorage(),
      storageNamespace: storageNamespace ?? client.url,
      ambientSignIns: {
        signIns: ambientSignIns ?? [oauth()],
        signInApi,
        // Mutations that start no session: the same socket client.
        bunvex: { mutation: (fn, args) => client.mutation(fn, args) },
      },
    });
    return { authClient, signInApi };
  }, [client]);

  return (
    <AuthProvider authClient={authClient} signInApi={signInApi}>
      <BunvexProviderWithAuth client={client} useAuth={useAuth}>
        <SessionWatcher isAuthenticated={api.isAuthenticated} />
        {children}
      </BunvexProviderWithAuth>
    </AuthProvider>
  );
}

/**
 * The auth actions: `setSession` keeps the session a method's sign-in returned; `signOut` revokes and forgets it.
 *
 * ```ts
 * const { setSession, signOut } = useAuthActions();
 * ```
 */
export function useAuthActions() {
  const actions = useContext(AuthActionsContext);
  if (actions === undefined) throw new Error("useAuthActions must be used within a <BunvexAuthProvider>.");
  return actions;
}

/**
 * The access token (a JWT), or null when signed out: for your HTTP actions (`Authorization: Bearer <token>`). Treat it
 * as an ID token: send it to no other server.
 */
export function useAuthToken() {
  return useContext(AuthTokenContext);
}
