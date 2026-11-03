// The anonymous method's hook (STUDY-201 §3.4), upstream's `methods/anonymous/react.test.tsx` ported (2), plus a failed
// call rejecting (it folds nothing, unlike the password hooks).
import { afterEach, describe, expect, test } from "bun:test";
import { anyApi, makeFunctionReference } from "@bunvex/server";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { AuthClient } from "../src/browser/sessionManager.ts";
import { InMemoryStorage } from "../src/browser/storage.ts";
import type { TokenBundle } from "../src/lib/types.ts";
import { type SignInAnonymouslyMutation, useSignInAnonymously } from "../src/methods/anonymous/react.tsx";
import { AuthProvider, useAuth } from "../src/react/client.tsx";
import { useAuthToken } from "../src/react/index.tsx";
import { stubSignInApi } from "./signInApi.ts";

const { signInApi, run: runSignIn } = stubSignInApi();
const NAMESPACE = "https://happy-animal-123.bunvex.example";
const bundle: TokenBundle = {
  accessToken: "access-1",
  refreshToken: "refresh-1",
  refreshTokenExpiresAt: 0,
  userId: "user-1",
};
// The app's `api.auth.signInAnonymously`: the hook reads its name, the stub ignores it.
const signInAnonymous = makeFunctionReference<"mutation">(
  "auth:signInAnonymously",
) as unknown as SignInAnonymouslyMutation;

function renderAnonymousAuth(
  api: { signInAnonymously: SignInAnonymouslyMutation } = { signInAnonymously: signInAnonymous },
) {
  const client = new AuthClient({
    mode: "spa",
    authApi: { refreshSession: async () => ({ kind: "noSession" as const }), signOut: async () => {} },
    storage: new InMemoryStorage(),
    storageNamespace: NAMESPACE,
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <AuthProvider authClient={client} signInApi={signInApi}>
      {children}
    </AuthProvider>
  );
  return renderHook(() => ({ auth: useAuth(), token: useAuthToken(), anonymous: useSignInAnonymously(api) }), {
    wrapper,
  });
}

describe("useSignInAnonymously", () => {
  afterEach(() => {
    cleanup();
    runSignIn.mockReset();
  });

  test("signIn adopts the envelope's bundle from signInAnonymously into the core client", async () => {
    runSignIn.mockResolvedValue({ status: "complete", tokens: bundle });
    const { result } = renderAnonymousAuth();
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));
    expect(result.current.auth.isAuthenticated).toBe(false);
    await act(async () => {
      await result.current.anonymous.signIn();
    });
    expect(runSignIn).toHaveBeenCalledTimes(1);
    expect(result.current.auth.isAuthenticated).toBe(true);
    expect(result.current.token).toBe("access-1");
  });

  test("signIn keeps its identity across rerenders", async () => {
    // `anyApi` is what the generated `api` is: a new reference object on each property read.
    const { result, rerender } = renderAnonymousAuth(anyApi.auth as never);
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));
    const first = result.current.anonymous.signIn;
    rerender();
    expect(result.current.anonymous.signIn).toBe(first);
  });

  test("a failed call rejects, and no session starts", async () => {
    runSignIn.mockRejectedValue(new Error("network blip"));
    const { result } = renderAnonymousAuth();
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));
    await act(async () => {
      await expect(result.current.anonymous.signIn()).rejects.toThrow("network blip");
    });
    expect(result.current.auth.isAuthenticated).toBe(false);
  });
});
