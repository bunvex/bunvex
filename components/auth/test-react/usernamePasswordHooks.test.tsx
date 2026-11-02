// The username + password method's hooks (STUDY-201 §3.4), upstream's `methods/username-password/react.test.tsx` ported
// (6 for each hook): their call goes through a stubbed sign-in API, not `useMutation`.
import { afterEach, describe, expect, test } from "bun:test";
import { anyApi } from "@bunvex/server";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { AuthClient } from "../src/browser/sessionManager.ts";
import { InMemoryStorage } from "../src/browser/storage.ts";
import type { TokenBundle } from "../src/lib/types.ts";
import {
  type SignInWithUsernamePasswordResult,
  type SignUpWithUsernamePasswordResult,
  useSignInWithUsernamePassword,
  useSignUpWithUsernamePassword,
} from "../src/methods/username-password/react.tsx";
import { AuthProvider, useAuth } from "../src/react/client.tsx";
import { useAuthToken } from "../src/react/index.tsx";
import { stubSignInApi } from "./signInApi.ts";

type Result = SignInWithUsernamePasswordResult | SignUpWithUsernamePasswordResult;
type Flow = { run: (c: typeof credentials) => Promise<Result>; pending: boolean };

const { signInApi, run: runMutation } = stubSignInApi();
const NAMESPACE = "https://happy-animal-123.bunvex.example";
const bundle: TokenBundle = {
  accessToken: "access-1",
  refreshToken: "refresh-1",
  refreshTokenExpiresAt: 0,
  userId: "user-1",
};
const credentials = { username: "alice", password: "hunter2" };
// `anyApi` is what the generated `api` is: a new reference object on each property read, as `api.auth` gives.
const authApi = anyApi.auth as never;

const flows: [string, () => Flow][] = [
  [
    "useSignInWithUsernamePassword",
    () => {
      const { signIn, pending } = useSignInWithUsernamePassword(authApi);
      return { run: signIn, pending };
    },
  ],
  [
    "useSignUpWithUsernamePassword",
    () => {
      const { signUp, pending } = useSignUpWithUsernamePassword(authApi);
      return { run: signUp, pending };
    },
  ],
];

function renderFlow(useFlow: () => Flow) {
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
  return renderHook(() => ({ auth: useAuth(), token: useAuthToken(), flow: useFlow() }), { wrapper });
}

describe.each(flows)("%s", (_name, useFlow) => {
  afterEach(() => {
    cleanup();
    runMutation.mockReset();
  });

  test("success adopts the session and returns the result", async () => {
    runMutation.mockResolvedValue({ status: "complete", tokens: bundle });
    const { result } = renderFlow(useFlow);
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));
    expect(result.current.auth.isAuthenticated).toBe(false);
    let returned!: Result;
    await act(async () => {
      returned = await result.current.flow.run(credentials);
    });
    expect(runMutation).toHaveBeenCalledWith(credentials);
    expect(returned).toEqual({ status: "complete", tokens: bundle });
    expect(result.current.auth.isAuthenticated).toBe(true);
    expect(result.current.token).toBe("access-1");
  });

  test("user error is returned without adopting a session", async () => {
    const failure = { status: "error", userError: { error: "USER_NOT_FOUND" } };
    runMutation.mockResolvedValue(failure);
    const { result } = renderFlow(useFlow);
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));
    let returned!: Result;
    await act(async () => {
      returned = await result.current.flow.run(credentials);
    });
    expect(returned).toEqual(failure as never);
    expect(result.current.auth.isAuthenticated).toBe(false);
  });

  test("thrown mutation folds into OTHER_ERROR preserving cause", async () => {
    const cause = new Error("network blip");
    runMutation.mockRejectedValue(cause);
    const { result } = renderFlow(useFlow);
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));
    let returned!: Result;
    await act(async () => {
      returned = await result.current.flow.run(credentials);
    });
    expect(returned).toEqual({ status: "error", userError: { error: "OTHER_ERROR", cause } });
    expect(result.current.auth.isAuthenticated).toBe(false);
  });

  test("pending is true while in flight and false after", async () => {
    let resolveMutation!: (value: unknown) => void;
    runMutation.mockReturnValue(
      new Promise((resolve) => {
        resolveMutation = resolve;
      }),
    );
    const { result } = renderFlow(useFlow);
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));
    expect(result.current.flow.pending).toBe(false);
    let pending!: Promise<unknown>;
    act(() => {
      pending = result.current.flow.run(credentials);
    });
    await waitFor(() => expect(result.current.flow.pending).toBe(true));
    await act(async () => {
      resolveMutation({ status: "complete", tokens: bundle });
      await pending;
    });
    expect(result.current.flow.pending).toBe(false);
  });

  test("pending resets to false when the mutation throws", async () => {
    runMutation.mockRejectedValue(new Error("boom"));
    const { result } = renderFlow(useFlow);
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));
    await act(async () => {
      await result.current.flow.run(credentials);
    });
    expect(result.current.flow.pending).toBe(false);
  });

  test("the callback keeps its identity across rerenders", async () => {
    const { result, rerender } = renderFlow(useFlow);
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));
    const first = result.current.flow.run;
    rerender();
    expect(result.current.flow.run).toBe(first);
  });
});
