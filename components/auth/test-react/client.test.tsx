// The React bindings of the session manager (STUDY-201 §3.4), upstream's `react/client.test.tsx` ported (14, at 2.0.0),
// and the watcher outside a provider. Upstream's `SessionWatcher` cases mock `useConvexAuth` and `useQuery`; here the
// real `BunvexProviderWithAuth` and `useQuery` run on a real `BunvexReactClient` whose deployment is stubbed
// (`deployment.ts`).
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { BunvexProviderWithAuth, BunvexReactClient } from "@bunvex/react";
import { makeFunctionReference } from "@bunvex/server";
import { act, cleanup, render, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { AuthClient, type SpaAuthApi } from "../src/browser/sessionManager.ts";
import { InMemoryStorage, JWT_STORAGE_KEY, REFRESH_TOKEN_STORAGE_KEY } from "../src/browser/storage.ts";
import type { TokenBundle } from "../src/lib/types.ts";
import { AuthProvider, SessionWatcher, useAuth } from "../src/react/client.tsx";
import { useAuthActions, useAuthToken } from "../src/react/index.tsx";
import { stubDeployment } from "./deployment.ts";
import { stubSignInApi } from "./signInApi.ts";

const NAMESPACE = "https://happy-animal-123.bunvex.example";
const SUFFIX = "httpshappyanimal123bunvexexample";

const bundle = (n: number): TokenBundle => ({
  accessToken: `access-${n}`,
  refreshToken: `refresh-${n}`,
  refreshTokenExpiresAt: 0,
  userId: "user-1",
});

function makeClient(authApi: Partial<SpaAuthApi> = {}, storage = new InMemoryStorage()) {
  const client = new AuthClient({
    mode: "spa",
    authApi: { refreshSession: async () => ({ kind: "noSession" as const }), signOut: async () => {}, ...authApi },
    storage,
    storageNamespace: NAMESPACE,
  });
  return { client, storage };
}

/** The provider around a hook giving every auth hook's value. */
function renderAuth(client: AuthClient) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <AuthProvider authClient={client} signInApi={stubSignInApi().signInApi}>
      {children}
    </AuthProvider>
  );
  return renderHook(() => ({ auth: useAuth(), token: useAuthToken(), actions: useAuthActions() }), { wrapper });
}

/** A render that is expected to throw, React's own error log silenced. */
function renderThrowing(hook: () => unknown) {
  const error = spyOn(console, "error").mockImplementation(() => {});
  try {
    return () => renderHook(hook);
  } finally {
    queueMicrotask(() => error.mockRestore());
  }
}

describe("React bindings", () => {
  afterEach(cleanup);

  test("useAuth throws when used outside a provider", () => {
    expect(renderThrowing(() => useAuth())).toThrow("useAuth must be used within a <BunvexAuthProvider>.");
  });

  test("useAuthActions throws when used outside a provider", () => {
    expect(renderThrowing(() => useAuthActions())).toThrow(
      "useAuthActions must be used within a <BunvexAuthProvider>.",
    );
  });

  test("useAuthToken returns null when used outside a provider", () => {
    // The token's context defaults to null rather than throwing.
    expect(renderHook(() => useAuthToken()).result.current).toBeNull();
  });

  test("AuthProvider initializes the client on mount and disposes on unmount", () => {
    const { client } = makeClient();
    const init = spyOn(client, "init");
    const dispose = spyOn(client, "dispose");
    const { unmount } = render(
      <AuthProvider authClient={client} signInApi={stubSignInApi().signInApi}>
        hi
      </AuthProvider>,
    );
    expect(init).toHaveBeenCalledTimes(1);
    expect(dispose).not.toHaveBeenCalled();
    unmount();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  test("reports loading then unauthenticated for an empty store", async () => {
    const { client } = makeClient();
    const { result } = renderAuth(client);
    expect(result.current.auth.isLoading).toBe(true);
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));
    expect(result.current.auth.isAuthenticated).toBe(false);
    expect(result.current.token).toBeNull();
  });

  test("hydrates a persisted session and exposes the token", async () => {
    const storage = new InMemoryStorage();
    storage.setItem(`${JWT_STORAGE_KEY}_${SUFFIX}`, "access-1");
    storage.setItem(`${REFRESH_TOKEN_STORAGE_KEY}_${SUFFIX}`, "refresh-1");
    const { client } = makeClient({}, storage);
    const { result } = renderAuth(client);
    await waitFor(() => expect(result.current.auth.isAuthenticated).toBe(true));
    expect(result.current.auth.isLoading).toBe(false);
    expect(result.current.token).toBe("access-1");
  });

  test("setSession authenticates and re-renders consumers", async () => {
    const { client } = makeClient();
    const { result } = renderAuth(client);
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));
    await act(async () => {
      await result.current.actions.setSession(bundle(1));
    });
    expect(result.current.auth.isAuthenticated).toBe(true);
    expect(result.current.token).toBe("access-1");
  });

  test("fetchAccessToken from the auth context returns the current token", async () => {
    const { client } = makeClient();
    const { result } = renderAuth(client);
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));
    await act(async () => {
      await result.current.actions.setSession(bundle(1));
    });
    expect(await result.current.auth.fetchAccessToken({ forceRefreshToken: false })).toBe("access-1");
  });

  test("signOut revokes on the server and clears consumers", async () => {
    const signOut = mock(async (rt: string) => {
      expect(rt).toBe("refresh-1");
    });
    const { client } = makeClient({ signOut });
    const { result } = renderAuth(client);
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));
    await act(async () => {
      await result.current.actions.setSession(bundle(1));
    });
    expect(result.current.auth.isAuthenticated).toBe(true);
    await act(async () => {
      await result.current.actions.signOut();
    });
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(result.current.auth.isAuthenticated).toBe(false);
    expect(result.current.token).toBeNull();
  });

  test("propagates a cross-tab sign-out after the provider remounts", async () => {
    const storage = new InMemoryStorage();
    const { client } = makeClient({}, storage);
    // Mounting the same client again (StrictMode's mount, unmount, mount; a route change) disposes it and inits it
    // again: signing out in another tab must still reach it, which holds only if init attaches the listener again.
    render(
      <AuthProvider authClient={client} signInApi={stubSignInApi().signInApi}>
        hi
      </AuthProvider>,
    ).unmount();
    const { result } = renderAuth(client);
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));
    await act(async () => {
      await result.current.actions.setSession(bundle(1));
    });
    expect(result.current.auth.isAuthenticated).toBe(true);
    // Another tab cleared the access token's key: the event goes to the listener the second init attached.
    const event = Object.assign(new Event("storage"), {
      storageArea: storage,
      key: `${JWT_STORAGE_KEY}_${SUFFIX}`,
      newValue: null,
    });
    act(() => {
      window.dispatchEvent(event);
    });
    expect(result.current.auth.isAuthenticated).toBe(false);
    expect(result.current.token).toBeNull();
  });
});

describe("SessionWatcher", () => {
  const IS_AUTHENTICATED = "auth:isAuthenticated";
  const isAuthenticatedRef = makeFunctionReference<"query">(IS_AUTHENTICATED) as never;
  const bunvexClients: BunvexReactClient[] = [];
  afterEach(async () => {
    cleanup();
    for (const c of bunvexClients.splice(0)) await c.close();
  });

  /** A session client hydrated as signed in, with a spy on the server sign-out. */
  function makeAuthenticatedClient() {
    const storage = new InMemoryStorage();
    storage.setItem(`${JWT_STORAGE_KEY}_${SUFFIX}`, "access-1");
    storage.setItem(`${REFRESH_TOKEN_STORAGE_KEY}_${SUFFIX}`, "refresh-1");
    const signOut = mock(async () => {});
    const { client } = makeClient({ signOut }, storage);
    return { client, signOut };
  }

  /** The watcher under the providers, on a real client whose deployment the test plays. */
  async function renderWatcher(client: AuthClient) {
    const bunvex = new BunvexReactClient(NAMESPACE);
    bunvexClients.push(bunvex);
    const deployment = stubDeployment(bunvex);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <AuthProvider authClient={client} signInApi={stubSignInApi().signInApi}>
        <BunvexProviderWithAuth client={bunvex} useAuth={useAuth}>
          <SessionWatcher isAuthenticated={isAuthenticatedRef} />
          {children}
        </BunvexProviderWithAuth>
      </AuthProvider>
    );
    const rendered = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(rendered.result.current.isAuthenticated).toBe(true));
    // Signed in locally: the client hands its token to the deployment.
    await waitFor(() => expect(deployment.setAuth).toHaveBeenCalled());
    return { ...rendered, deployment };
  }

  test("signs out when the server reports the session is gone", async () => {
    const { client, signOut } = makeAuthenticatedClient();
    const { result, deployment } = await renderWatcher(client);
    deployment.accept(true);
    deployment.serve(IS_AUTHENTICATED, true);
    expect(deployment.isSubscribed(IS_AUTHENTICATED)).toBe(true);

    // The session is revoked on the server: the subscription's next answer is `false`, which clears the local session.
    deployment.serve(IS_AUTHENTICATED, false);

    await waitFor(() => expect(result.current.isAuthenticated).toBe(false));
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  test("stays signed in while the server reports the session live", async () => {
    const { client, signOut } = makeAuthenticatedClient();
    const { result, deployment } = await renderWatcher(client);
    deployment.accept(true);
    deployment.serve(IS_AUTHENTICATED, true);

    expect(deployment.subscriptionsTo(IS_AUTHENTICATED)).toEqual([{ path: IS_AUTHENTICATED, args: {} }]);
    expect(signOut).not.toHaveBeenCalled();
    expect(result.current.isAuthenticated).toBe(true);
  });

  test("does not subscribe until the backend accepts the token", async () => {
    // Signed in locally, but the deployment has not accepted the token (the handshake is pending, or the client gave
    // up on auth). A query run now would see no identity and answer `false` with the session still live, so the
    // watcher must not ask.
    const { client, signOut } = makeAuthenticatedClient();
    const { result, deployment } = await renderWatcher(client);
    deployment.serve(IS_AUTHENTICATED, false);

    expect(deployment.subscriptionsTo(IS_AUTHENTICATED)).toEqual([]);
    expect(signOut).not.toHaveBeenCalled();
    expect(result.current.isAuthenticated).toBe(true);
  });

  test("stops subscribing when the backend drops the token", async () => {
    const { client, signOut } = makeAuthenticatedClient();
    const { result, deployment } = await renderWatcher(client);
    deployment.accept(true);
    deployment.serve(IS_AUTHENTICATED, true);
    expect(deployment.isSubscribed(IS_AUTHENTICATED)).toBe(true);

    // The client dropped its auth (a refresh failed on the network, say): the gate closes, so the re-run without the
    // identity is never read.
    deployment.accept(false);
    deployment.serve(IS_AUTHENTICATED, false);

    expect(deployment.isSubscribed(IS_AUTHENTICATED)).toBe(false);
    expect(signOut).not.toHaveBeenCalled();
    expect(result.current.isAuthenticated).toBe(true);
  });

  test("throws outside an AuthProvider", () => {
    expect(renderThrowing(() => SessionWatcher({ isAuthenticated: isAuthenticatedRef }))).toThrow(
      "SessionWatcher must be rendered under AuthProvider.",
    );
  });
});
