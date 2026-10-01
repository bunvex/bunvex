// Auth in React, as Convex's `react/ConvexAuthState.tsx` and `react/auth_helpers.tsx` (STUDY-27 §1.7): an
// auth library's state (`useAuth`) drives the client's `setAuth` / `clearAuth`, and the tree reads whether the
// SERVER accepted the token, not only whether the library is signed in.
import {
  createContext,
  createElement,
  type Dispatch,
  Fragment,
  type ReactNode,
  type SetStateAction,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { BunvexReactClient } from "./client.ts";
import { BunvexProvider } from "./context.ts";

type AuthClient = Pick<BunvexReactClient, "setAuth" | "clearAuth">;
type FetchAccessToken = (args: { forceRefreshToken: boolean }) => Promise<string | null>;

export type BunvexAuthState = { isLoading: boolean; isAuthenticated: boolean; isRefreshing: boolean };

const BunvexAuthContext = createContext<BunvexAuthState>(undefined as unknown as BunvexAuthState);

/** Whether the server accepted the auth: loading until it answers; refreshing while a refused token is replaced. */
export function useBunvexAuth(): BunvexAuthState {
  const state = useContext(BunvexAuthContext);
  if (state === undefined)
    throw new Error(
      "Could not find `BunvexProviderWithAuth` as an ancestor component. This component may be missing, or you might have two instances of the `@bunvex/react` module loaded in your project.",
    );
  return state;
}

/**
 * `BunvexProvider`, with auth from an auth library: `useAuth()` returns its `{isLoading, isAuthenticated,
 * fetchAccessToken}`. While it is signed in, the client authenticates with `fetchAccessToken`.
 */
export function BunvexProviderWithAuth({
  children,
  client,
  useAuth,
}: {
  children?: ReactNode;
  client: AuthClient;
  useAuth: () => { isLoading: boolean; isAuthenticated: boolean; fetchAccessToken: FetchAccessToken };
}) {
  const { isLoading: providerLoading, isAuthenticated: providerAuthenticated, fetchAccessToken } = useAuth();
  // null: not known yet.
  const [serverAuthenticated, setServerAuthenticated] = useState<boolean | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);

  // The library went back to loading (rare): loading again, so the state goes loading → authenticated
  // without passing through unauthenticated.
  if (providerLoading && serverAuthenticated !== null) {
    setServerAuthenticated(null);
    setIsRefreshing(false);
  }
  // The library signed out: so is the tree.
  if (!providerLoading && !providerAuthenticated && serverAuthenticated !== false) {
    setServerAuthenticated(false);
    setIsRefreshing(false);
  }

  const isAuthenticated = providerAuthenticated && (serverAuthenticated ?? false);
  const isLoading = serverAuthenticated === null;
  const refreshing = isRefreshing && isAuthenticated;
  // A stable value: `useBunvexAuth()` users re-render only when the state changes.
  const state = useMemo(
    () => ({ isLoading, isAuthenticated, isRefreshing: refreshing }),
    [isLoading, isAuthenticated, refreshing],
  );

  const effects = {
    providerAuthenticated,
    providerLoading,
    fetchAccessToken,
    client,
    setServerAuthenticated,
    setIsRefreshing,
  };
  return createElement(
    BunvexAuthContext.Provider,
    { value: state },
    createElement(SetAuthFirst, effects),
    createElement(BunvexProvider, { client: client as BunvexReactClient }, children),
    createElement(ClearAuthLast, effects),
  );
}

type EffectProps = {
  providerAuthenticated: boolean;
  providerLoading: boolean;
  fetchAccessToken: FetchAccessToken;
  client: AuthClient;
  setServerAuthenticated: Dispatch<SetStateAction<boolean | null>>;
  setIsRefreshing: Dispatch<SetStateAction<boolean>>;
};

/** The first child: `setAuth` runs before the children's effects subscribe to queries. */
function SetAuthFirst(p: EffectProps) {
  const { providerAuthenticated, providerLoading, fetchAccessToken, client, setServerAuthenticated, setIsRefreshing } =
    p;
  // biome-ignore lint/correctness/useExhaustiveDependencies: as Convex, a new token fetcher or a loading change re-runs it (a new auth context)
  useEffect(() => {
    if (!providerAuthenticated) return;
    let relevant = true;
    client.setAuth(
      fetchAccessToken,
      (accepted) => {
        if (relevant) setServerAuthenticated(() => accepted);
      },
      (refreshing) => {
        if (relevant) setIsRefreshing(refreshing);
      },
    );
    return () => {
      relevant = false;
      // Unmounted, or something changed before the token was answered: not loaded.
      setServerAuthenticated((accepted) => (accepted ? false : null));
      setIsRefreshing(false);
    };
  }, [providerAuthenticated, fetchAccessToken, providerLoading, client, setServerAuthenticated, setIsRefreshing]);
  return null;
}

/** The last child: `clearAuth` runs after the children unsubscribed, so their queries do not re-run signed out. */
function ClearAuthLast(p: EffectProps) {
  const { providerAuthenticated, providerLoading, fetchAccessToken, client, setServerAuthenticated, setIsRefreshing } =
    p;
  // biome-ignore lint/correctness/useExhaustiveDependencies: as Convex, a new token fetcher or a loading change re-runs it (a new auth context)
  useEffect(() => {
    if (!providerAuthenticated) return;
    return () => {
      client.clearAuth();
      // Loading again: a new `fetchAccessToken` (e.g. another organization) is a new auth context; if the
      // library reports signed out on the next render, that overrides this.
      setServerAuthenticated(() => null);
      setIsRefreshing(false);
    };
  }, [providerAuthenticated, fetchAccessToken, providerLoading, client, setServerAuthenticated, setIsRefreshing]);
  return null;
}

const children = (show: boolean, c: ReactNode) => (show ? createElement(Fragment, null, c) : null);

/** Renders its children once the server accepted the auth. */
export function Authenticated({ children: c }: { children: ReactNode }) {
  const { isLoading, isAuthenticated } = useBunvexAuth();
  return children(!isLoading && isAuthenticated, c);
}

/** Renders its children once it is known the user is signed out (or the server refused the token). */
export function Unauthenticated({ children: c }: { children: ReactNode }) {
  const { isLoading, isAuthenticated } = useBunvexAuth();
  return children(!isLoading && !isAuthenticated, c);
}

/** Renders its children while the auth state is not known yet. */
export function AuthLoading({ children: c }: { children: ReactNode }) {
  return children(useBunvexAuth().isLoading, c);
}

/** Renders its children while a signed-in client replaces a token the server refused. */
export function AuthRefreshing({ children: c }: { children: ReactNode }) {
  const { isAuthenticated, isRefreshing } = useBunvexAuth();
  return children(isAuthenticated && isRefreshing, c);
}
