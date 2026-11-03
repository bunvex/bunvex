// The React side of the session manager (STUDY-201 §1.11), v2's `react/client.tsx` in bunvex's words (C-4): it binds an
// `AuthClient` to React and provides what the hooks read (the auth state `BunvexProviderWithAuth` asks for, the actions,
// the token, the sign-in API the methods' hooks run their functions through).
"use client";

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from "react";
import type { AuthSignInApi } from "../browser/ambientSignInClient.ts";
import { type AuthClient, INITIAL_AUTH_STATE } from "../browser/sessionManager.ts";
import type { SlimTokenBundle, TokenBundle } from "../lib/types.ts";

export type { AuthSignInApi };

const AuthSignInApiContext = createContext<AuthSignInApi | undefined>(undefined);

/**
 * The provider's {@link AuthSignInApi}: how a method's hooks run their sign-in function (instead of `useMutation`), which
 * keeps them working whatever the session model. Throws outside an auth provider.
 */
export function useAuthSignInApi(): AuthSignInApi {
  const signInApi = useContext(AuthSignInApiContext);
  if (signInApi === undefined)
    throw new Error(
      "useAuthSignInApi must be used within a <BunvexAuthProvider> (or, under Next.js, a <BunvexAuthNextjsProvider>).",
    );
  return signInApi;
}

// What React reads while rendering on a server and hydrating, before `init()` read the storage: always loading.
const getServerSnapshot = () => INITIAL_AUTH_STATE;

/** What {@link useAuthActions} returns. */
export type AuthActionsContextType = {
  /**
   * Start or replace the session: a full {@link TokenBundle} in a single-page app (the client holds the refresh token),
   * a {@link SlimTokenBundle} behind a server-rendering host (the refresh token is in an httpOnly cookie).
   */
  setSession: (session: TokenBundle | SlimTokenBundle) => Promise<void>;
  /** Sign out: revoke the session on the server and forget it here. */
  signOut: () => Promise<void>;
};

export const AuthActionsContext = createContext<AuthActionsContextType | undefined>(undefined);

/** The provider's {@link AuthClient}, which the methods' hooks read (`react/methods.ts`); apps do not use it. */
export const AuthClientContext = createContext<AuthClient | undefined>(undefined);

/** The access token (a JWT), or null when signed out. */
export const AuthTokenContext = createContext<string | null>(null);

type AuthState = {
  isLoading: boolean;
  isAuthenticated: boolean;
  fetchAccessToken: (args: { forceRefreshToken: boolean }) => Promise<string | null>;
};

/** What `BunvexProviderWithAuth` reads, through {@link useAuth}. */
const AuthInternalContext = createContext<AuthState | undefined>(undefined);

/**
 * The `useAuth` given to `BunvexProviderWithAuth`: a function of the module, so its identity never changes (a new one
 * would rerun the client's authentication), reading what {@link AuthProvider} provides.
 */
export function useAuth(): AuthState {
  const auth = useContext(AuthInternalContext);
  if (auth === undefined) throw new Error("useAuth must be used within a <BunvexAuthProvider>.");
  return auth;
}

/**
 * An {@link AuthClient} bound to React, with the auth state, the actions, the token and the sign-in API provided;
 * `BunvexAuthProvider` renders it around `BunvexProviderWithAuth`.
 */
export function AuthProvider({
  authClient,
  signInApi,
  children,
}: {
  authClient: AuthClient;
  /** How the methods' hooks run their sign-in functions. */
  signInApi: AuthSignInApi;
  children: ReactNode;
}) {
  const state = useSyncExternalStore(authClient.subscribe, authClient.getSnapshot, getServerSnapshot);

  useEffect(() => {
    // React StrictMode mounts, cleans up and mounts again on the same client: init, dispose, init. They are symmetric,
    // and the second init attaches again the listener the dispose removed.
    void authClient.init();
    return () => authClient.dispose();
  }, [authClient]);

  const fetchAccessToken = useCallback(
    (args: { forceRefreshToken: boolean }) => authClient.fetchAccessToken(args),
    [authClient],
  );
  const authState = useMemo(
    () => ({ isLoading: state.isLoading, isAuthenticated: state.isAuthenticated, fetchAccessToken }),
    [state.isLoading, state.isAuthenticated, fetchAccessToken],
  );
  const actions = useMemo<AuthActionsContextType>(
    () => ({ setSession: authClient.setSession, signOut: authClient.signOut }),
    [authClient],
  );

  return (
    <AuthClientContext.Provider value={authClient}>
      <AuthInternalContext.Provider value={authState}>
        <AuthSignInApiContext.Provider value={signInApi}>
          <AuthActionsContext.Provider value={actions}>
            <AuthTokenContext.Provider value={state.token}>{children}</AuthTokenContext.Provider>
          </AuthActionsContext.Provider>
        </AuthSignInApiContext.Provider>
      </AuthInternalContext.Provider>
    </AuthClientContext.Provider>
  );
}
