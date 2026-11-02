// The OAuth client the core's provider registers (STUDY-201 C-5, §3.4), upstream's `methods/oauth/client.test.ts`
// ported (28), its URL parameters bunvex's (`bunvexAuthCode`, `bunvexAuthError`, DV-577) and its app error class
// bunvex's (`BunvexError`). The page's URL and history are the DOM preload's.
import { afterEach, describe, expect, mock, test } from "bun:test";
import { BunvexError } from "@bunvex/values";
import type { AuthSignInApi } from "../src/browser/ambientSignInClient.ts";
import { AuthClient, type AuthState } from "../src/browser/sessionManager.ts";
import { InMemoryStorage, type TokenStorage } from "../src/browser/storage.ts";
import { oauth } from "../src/methods/oauth/client.ts";
import {
  acmeRefs,
  calledPath,
  completed,
  flowStorage,
  invalidCode,
  NAMESPACE,
  readFlow,
  restoreNavigatorProduct,
  seedPendingFlow,
  setupOAuth,
  stubReactNative,
  waitFor,
} from "./oauthFlow.ts";

const at = (url: string, state: unknown = null) => window.history.replaceState(state, "", url);

describe("OAuth client", () => {
  afterEach(() => {
    at("/");
    restoreNavigatorProduct();
  });

  test("registers actions and a null flow error at setup", () => {
    const { actions, flowError } = setupOAuth();
    expect(actions.signIn).toBeTypeOf("function");
    expect(flowError()).toBeNull();
  });

  test("registering oauth() twice on one provider throws", () => {
    const signInApi = { mutation: mock(), action: mock() } as unknown as AuthSignInApi;
    expect(
      () =>
        new AuthClient({
          mode: "spa",
          authApi: { refreshSession: async () => ({ kind: "noSession" as const }), signOut: async () => {} },
          storage: new InMemoryStorage(),
          storageNamespace: NAMESPACE,
          ambientSignIns: { signIns: [oauth(), oauth()], signInApi, bunvex: { mutation: mock() } },
        }),
    ).toThrow(/registered twice/);
  });

  test("init redeems a callback code and adopts the session", async () => {
    at("/?bunvexAuthCode=code-1");
    const storage = new InMemoryStorage();
    seedPendingFlow(storage);
    const { client, mutation, flowError } = setupOAuth({ storage });
    mutation.mockResolvedValueOnce(completed);

    await client.init();
    await waitFor(() => expect(client.getSnapshot().isAuthenticated).toBe(true));
    expect(mutation).toHaveBeenCalledTimes(1);
    // The reference is rebuilt from the saved path.
    expect(calledPath(mutation)).toBe("auth:completeSignInAcme");
    expect(mutation.mock.calls[0]![1]).toEqual({ code: "code-1", state: "state-1" });
    expect(client.getSnapshot().token).toBe("access-1");
    expect(flowError()).toBeNull();
    // The one-time code is gone from the URL.
    expect(window.location.search).toBe("");
  });

  test("stripping the callback params keeps the history state", async () => {
    // Routers (React Router) keep their own entry state in `history.state`.
    at("/?bunvexAuthCode=code-1", { idx: 3 });
    const storage = new InMemoryStorage();
    seedPendingFlow(storage);
    const { client, mutation } = setupOAuth({ storage });
    mutation.mockResolvedValueOnce(completed);

    await client.init();
    await waitFor(() => expect(client.getSnapshot().isAuthenticated).toBe(true));
    expect(window.location.search).toBe("");
    expect(window.history.state).toEqual({ idx: 3 });
  });

  test("never reports signed out while a code is redeemed", async () => {
    at("/?bunvexAuthCode=code-1");
    const storage = new InMemoryStorage();
    seedPendingFlow(storage);
    const { client, mutation } = setupOAuth({ storage });
    const { promise, resolve } = Promise.withResolvers<typeof completed>();
    mutation.mockReturnValueOnce(promise);
    // The session loads long before the redemption ends: any snapshot loaded and not signed in meanwhile would send the
    // user to a sign-in screen.
    const signedOut: AuthState[] = [];
    const unsubscribe = client.subscribe(() => {
      const state = client.getSnapshot();
      if (!state.isLoading && !state.isAuthenticated) signedOut.push(state);
    });

    await client.init();
    expect(client.getSnapshot().isLoading).toBe(true);
    resolve(completed);
    await waitFor(() => expect(client.getSnapshot().isAuthenticated).toBe(true));
    expect(client.getSnapshot().isLoading).toBe(false);
    expect(signedOut).toEqual([]);
    unsubscribe();
  });

  test("a second client on the same URL finds it clean and no-ops", async () => {
    at("/?bunvexAuthCode=code-1");
    const storage = new InMemoryStorage();
    seedPendingFlow(storage);
    const { client: first, mutation: firstMutation } = setupOAuth({ storage });
    firstMutation.mockResolvedValueOnce(completed);
    await first.init();
    await waitFor(() => expect(first.getSnapshot().isAuthenticated).toBe(true));
    expect(window.location.search).toBe("");

    // The code is one-time: a second client over the same page must not redeem it again.
    const { client: second, mutation: secondMutation, flowError: secondFlowError } = setupOAuth({ storage });
    await second.init();
    expect(secondMutation).not.toHaveBeenCalled();
    // A code still in the URL with the flow consumed would read INVALID_FLOW here.
    expect(secondFlowError()).toBeNull();
  });

  test("a callback error param sets the flow error and strips the URL", async () => {
    at("/?bunvexAuthError=access_denied");
    const { client, mutation, flowError } = setupOAuth();
    await client.init();
    expect(flowError()).toEqual({ error: "ACCESS_DENIED" });
    expect(mutation).not.toHaveBeenCalled();
    expect(window.location.search).toBe("");
  });

  test("a callback error consumes the pending flow", async () => {
    at("/?bunvexAuthError=access_denied");
    const storage = new InMemoryStorage();
    seedPendingFlow(storage);
    const { client, flowError } = setupOAuth({ storage });
    await client.init();
    expect(flowError()?.error).toBe("ACCESS_DENIED");
    // The flow ended in an error: its state can never complete.
    await waitFor(() => expect(readFlow(storage)).toBeNull());
  });

  test("an expired error param sets EXPIRED", async () => {
    at("/?bunvexAuthError=expired");
    const { client, flowError } = setupOAuth();
    await client.init();
    expect(flowError()).toEqual({ error: "EXPIRED" });
  });

  test("an oauth_error param sets OTHER_ERROR with the param as cause", async () => {
    at("/?bunvexAuthError=oauth_error");
    const { client, flowError } = setupOAuth();
    await client.init();
    expect(flowError()).toEqual({ error: "OTHER_ERROR", cause: "oauth_error" });
  });

  test("an unknown error param sets OTHER_ERROR", async () => {
    at("/?bunvexAuthError=server_exploded");
    const { client, flowError } = setupOAuth();
    await client.init();
    expect(flowError()).toEqual({ error: "OTHER_ERROR", cause: "server_exploded" });
  });

  test("a code without a pending flow sets INVALID_FLOW", async () => {
    at("/?bunvexAuthCode=code-1");
    const { client, mutation, flowError } = setupOAuth();
    await client.init();
    await waitFor(() => expect(flowError()?.error).toBe("INVALID_FLOW"));
    expect(mutation).not.toHaveBeenCalled();
    expect(client.getSnapshot().isLoading).toBe(false);
    expect(client.getSnapshot().isAuthenticated).toBe(false);
  });

  test("a pending flow without a completeSignIn path is invalid", async () => {
    // A record an older client saved, or one tampered with: neither a crash nor half a redemption.
    at("/?bunvexAuthCode=code-1");
    const storage = new InMemoryStorage();
    void flowStorage(storage).set("flow", JSON.stringify({ providerName: "acme", state: "state-1" }));
    const { client, mutation, flowError } = setupOAuth({ storage });
    await client.init();
    await waitFor(() => expect(flowError()?.error).toBe("INVALID_FLOW"));
    expect(mutation).not.toHaveBeenCalled();
  });

  test("an INVALID_CODE error sets EXPIRED", async () => {
    at("/?bunvexAuthCode=code-1");
    const storage = new InMemoryStorage();
    seedPendingFlow(storage);
    const { client, mutation, flowError } = setupOAuth({ storage });
    mutation.mockResolvedValueOnce(invalidCode);
    await client.init();
    await waitFor(() => expect(flowError()?.error).toBe("EXPIRED"));
    expect(client.getSnapshot().isAuthenticated).toBe(false);
  });

  test("a failed redemption sets the flow error before loading ends", async () => {
    at("/?bunvexAuthCode=code-1");
    const storage = new InMemoryStorage();
    seedPendingFlow(storage);
    const { client, mutation, flowError } = setupOAuth({ storage });
    mutation.mockResolvedValueOnce(invalidCode);
    // The flow error at each change that leaves the client loaded: a page reading both never sees signed out without
    // the error that explains it.
    const errorsOnceLoaded: unknown[] = [];
    client.subscribe(() => {
      if (!client.getSnapshot().isLoading) errorsOnceLoaded.push(flowError());
    });
    await client.init();
    await waitFor(() => expect(flowError()?.error).toBe("EXPIRED"));
    expect(errorsOnceLoaded).not.toHaveLength(0);
    expect(errorsOnceLoaded).not.toContain(null);
  });

  test("a failed redemption sets OTHER_ERROR with the thrown error", async () => {
    // Also a saved path whose export was renamed mid-flight: the call fails the same way.
    at("/?bunvexAuthCode=code-1");
    const storage = new InMemoryStorage();
    seedPendingFlow(storage);
    const { client, mutation, flowError } = setupOAuth({ storage });
    const boom = new Error("boom");
    mutation.mockRejectedValueOnce(boom);
    await client.init();
    await waitFor(() => expect(flowError()).toEqual({ error: "OTHER_ERROR", cause: boom }));
    expect(client.getSnapshot().isLoading).toBe(false);
  });

  test("an app rejection sets REJECTED with the BunvexError data", async () => {
    at("/?bunvexAuthCode=code-1");
    const storage = new InMemoryStorage();
    seedPendingFlow(storage);
    const { client, mutation, flowError } = setupOAuth({ storage });
    mutation.mockRejectedValueOnce(new BunvexError("A verified email is required to sign in"));
    await client.init();
    await waitFor(() =>
      expect(flowError()).toEqual({ error: "REJECTED", data: "A verified email is required to sign in" }),
    );
    expect(client.getSnapshot().isAuthenticated).toBe(false);
  });

  test("an app rejection passes non-string data through", async () => {
    at("/?bunvexAuthCode=code-1");
    const storage = new InMemoryStorage();
    seedPendingFlow(storage);
    const { client, mutation, flowError } = setupOAuth({ storage });
    mutation.mockRejectedValueOnce(new BunvexError({ reason: "policy" }));
    await client.init();
    // The app's backend chose the shape, so the app can read it.
    await waitFor(() => expect(flowError()).toEqual({ error: "REJECTED", data: { reason: "policy" } }));
  });

  test("a rejected storage read during redemption sets OTHER_ERROR", async () => {
    at("/?bunvexAuthCode=code-1");
    // Reads of the saved flow fail, as an async storage's might; the session's still work.
    const storage: TokenStorage = {
      getItem: (key) =>
        key.startsWith("__bunvexAuthProvider_oauth_flow") ? Promise.reject(new Error("storage broken")) : null,
      setItem: () => {},
      removeItem: () => {},
    };
    const { client, mutation, flowError } = setupOAuth({ storage });
    await client.init();
    await waitFor(() => expect(flowError()?.error).toBe("OTHER_ERROR"));
    expect(mutation).not.toHaveBeenCalled();
    expect(client.getSnapshot().isLoading).toBe(false);
  });

  test("a rejected storage removal during error cleanup keeps the flow error", async () => {
    at("/?bunvexAuthError=access_denied");
    const storage: TokenStorage = {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => Promise.reject(new Error("storage broken")),
    };
    const { client, flowError } = setupOAuth({ storage });
    await client.init();
    expect(flowError()?.error).toBe("ACCESS_DENIED");
    // The cleanup is not awaited: one turn of the event loop for it (an unhandled rejection would fail the run).
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(flowError()?.error).toBe("ACCESS_DENIED");
  });

  test("signIn starts a flow, persists it, and returns the redirect", async () => {
    stubReactNative();
    const { mutation, bunvexMutation, actions, storage } = setupOAuth();
    bunvexMutation.mockResolvedValueOnce({ redirect: "https://provider.example/auth?client_id=x", state: "state-1" });
    const outcome = await actions.signIn(acmeRefs, { redirectTo: "http://localhost/app" });
    expect(bunvexMutation).toHaveBeenCalledTimes(1);
    expect(bunvexMutation).toHaveBeenCalledWith(acmeRefs.startSignIn, { redirectTo: "http://localhost/app" });
    // Starting starts no session: it bypasses the sign-in API (the auth proxy under server rendering refuses it).
    expect(mutation).not.toHaveBeenCalled();
    expect(outcome).toEqual({ status: "redirect", redirect: new URL("https://provider.example/auth?client_id=x") });
    // The saved flow has completeSignIn's path, so a page that never held the references can complete it.
    expect(readFlow(storage)).toEqual({
      providerName: "acme",
      state: "state-1",
      completeSignIn: "auth:completeSignInAcme",
    });
  });

  test("signIn with a code completes the pending flow", async () => {
    const storage = new InMemoryStorage();
    seedPendingFlow(storage);
    const { client, mutation, actions } = setupOAuth({ storage });
    mutation.mockResolvedValueOnce(completed);
    expect(await actions.signIn(acmeRefs, { code: "code-1" })).toEqual({ status: "complete" });
    expect(mutation).toHaveBeenCalledTimes(1);
    expect(calledPath(mutation)).toBe("auth:completeSignInAcme");
    expect(mutation.mock.calls[0]![1]).toEqual({ code: "code-1", state: "state-1" });
    expect(client.getSnapshot().isAuthenticated).toBe(true);
  });

  test("signIn with a code returns a failure rather than publishing it", async () => {
    const { mutation, actions, flowError } = setupOAuth();
    expect(await actions.signIn(acmeRefs, { code: "code-1" })).toEqual({
      status: "error",
      userError: { error: "INVALID_FLOW" },
    });
    expect(flowError()).toBeNull();
    expect(mutation).not.toHaveBeenCalled();
  });

  test("signIn clears a previous flow error", async () => {
    at("/?bunvexAuthError=access_denied");
    stubReactNative();
    const { client, bunvexMutation, actions, flowError } = setupOAuth();
    await client.init();
    expect(flowError()?.error).toBe("ACCESS_DENIED");
    bunvexMutation.mockResolvedValueOnce({ redirect: "https://provider.example/auth", state: "state-2" });
    // No page URL to default to on React Native: `redirectTo` is required.
    await actions.signIn(acmeRefs, { redirectTo: "http://localhost/app" });
    expect(flowError()).toBeNull();
  });

  test("a failed start resolves to OTHER_ERROR with the thrown error", async () => {
    const { bunvexMutation, actions, flowError, storage } = setupOAuth();
    const boom = new Error("boom");
    bunvexMutation.mockRejectedValueOnce(boom);
    expect(await actions.signIn(acmeRefs)).toEqual({
      status: "error",
      userError: { error: "OTHER_ERROR", cause: boom },
    });
    // The caller has the failure: it is not the flow error too.
    expect(flowError()).toBeNull();
    expect(flowStorage(storage).get("flow")).toBeNull();
  });

  test("a start that can't save the flow resolves to OTHER_ERROR", async () => {
    const storage: TokenStorage = {
      getItem: () => null,
      setItem: () => Promise.reject(new Error("storage broken")),
      removeItem: () => {},
    };
    const { bunvexMutation, actions, flowError } = setupOAuth({ storage });
    bunvexMutation.mockResolvedValueOnce({ redirect: "https://provider.example/auth", state: "state-1" });
    expect(await actions.signIn(acmeRefs)).toMatchObject({
      status: "error",
      userError: { error: "OTHER_ERROR", cause: new Error("storage broken") },
    });
    expect(flowError()).toBeNull();
  });

  test("a BunvexError from the start is OTHER_ERROR too", async () => {
    // Starting runs no app code, so nothing there refuses a sign-in.
    const { bunvexMutation, actions } = setupOAuth();
    const rejected = new BunvexError("Sign-ups are closed");
    bunvexMutation.mockRejectedValueOnce(rejected);
    expect(await actions.signIn(acmeRefs)).toEqual({
      status: "error",
      userError: { error: "OTHER_ERROR", cause: rejected },
    });
  });

  test("a foreign code/error param is ignored and left in the URL", async () => {
    at("/?code=foreign&error=foreign");
    const { client, mutation, flowError } = setupOAuth();
    await client.init();
    // Only the prefixed parameters are the client's; a plain code or error is the app's.
    expect(mutation).not.toHaveBeenCalled();
    expect(flowError()).toBeNull();
    expect(window.location.search).toBe("?code=foreign&error=foreign");
  });
});
