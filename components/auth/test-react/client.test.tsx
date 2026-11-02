// The React bindings of the session manager (STUDY-201 §3.4), upstream's `react/client.test.tsx` ported (10).
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, render, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { AuthClient, type SpaAuthApi } from "../src/browser/sessionManager.ts";
import { InMemoryStorage, JWT_STORAGE_KEY, REFRESH_TOKEN_STORAGE_KEY } from "../src/browser/storage.ts";
import type { TokenBundle } from "../src/lib/types.ts";
import { AuthProvider, useAuth } from "../src/react/client.tsx";
import { useAuthActions, useAuthToken } from "../src/react/index.tsx";
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
