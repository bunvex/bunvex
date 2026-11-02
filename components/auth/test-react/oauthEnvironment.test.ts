// The OAuth client where there is no page URL (STUDY-201 §3.4), upstream's `methods/oauth/clientEnvironment.test.ts`
// ported: no `window` at all (a server), or one without a location (React Native). Vitest's `stubGlobal` becomes a
// `window` defined here, the DOM preload's put back after each test.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { acmeRefs, readFlow, setupOAuth } from "./oauthFlow.ts";

const ORIGINAL_WINDOW = Object.getOwnPropertyDescriptor(globalThis, "window");
const setWindow = (value: unknown) =>
  Object.defineProperty(globalThis, "window", { value, configurable: true, writable: true });

describe("OAuth client with no page URL", () => {
  afterEach(() => {
    if (ORIGINAL_WINDOW === undefined) delete (globalThis as { window?: unknown }).window;
    else Object.defineProperty(globalThis, "window", ORIGINAL_WINDOW);
  });

  test("init does nothing when there is no window", async () => {
    setWindow(undefined);
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      const { client, mutation } = setupOAuth();
      await client.init();
      expect(logged).not.toHaveBeenCalled();
      expect(mutation).not.toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });

  test("init does nothing when the window has no location", async () => {
    // React Native's shape: reading `window.location.href` would throw, logged as a failed init callback.
    setWindow({});
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      const { client, mutation } = setupOAuth();
      await client.init();
      expect(logged).not.toHaveBeenCalled();
      expect(mutation).not.toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });

  test("signIn without redirectTo says redirectTo is required", async () => {
    setWindow({});
    const { actions, bunvexMutation } = setupOAuth();
    await expect(actions.signIn(acmeRefs)).rejects.toThrow(
      "`redirectTo` is required where there is no current page URL, such as React Native.",
    );
    expect(bunvexMutation).not.toHaveBeenCalled();
  });

  test("a signIn that throws leaves the previous flow error alone", async () => {
    // An error put in place by a callback, on a page with a URL.
    setWindow({
      location: { href: "https://app.example/?bunvexAuthError=access_denied" },
      history: { state: null, replaceState: () => {} },
    });
    const { client, actions, flowError } = setupOAuth();
    await client.init();
    expect(flowError()?.error).toBe("ACCESS_DENIED");
    setWindow({});
    await expect(actions.signIn(acmeRefs)).rejects.toThrow();
    expect(flowError()?.error).toBe("ACCESS_DENIED");
  });

  test("signIn with redirectTo starts a flow without navigating", async () => {
    // Assigning `window.location.href` would throw here: a flow starting must not try (React Native opens the URL).
    setWindow({});
    const { actions, bunvexMutation, storage } = setupOAuth();
    bunvexMutation.mockResolvedValueOnce({ redirect: "https://provider.example/auth", state: "state-1" });
    expect(await actions.signIn(acmeRefs, { redirectTo: "https://app.example/done" })).toEqual({
      status: "redirect",
      redirect: new URL("https://provider.example/auth"),
    });
    expect(readFlow(storage)).toEqual({
      providerName: "acme",
      state: "state-1",
      completeSignIn: "auth:completeSignInAcme",
    });
  });
});
