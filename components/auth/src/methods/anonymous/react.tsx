// The anonymous method's React hook (STUDY-201 §1.11), v2's: it runs `signInAnonymously` through the provider's sign-in
// API and keeps the session. Unlike the password hooks it folds nothing: a failed call rejects.
"use client";

import type { FunctionReference } from "@bunvex/server";
import { useCallback } from "react";
import type { ClientView, SignInComplete } from "../../lib/types.ts";
import { useAuthSignInApi } from "../../react/client.tsx";
import { useStableFunctionReference } from "../../react/functionReference.ts";
import { useAuthActions } from "../../react/index.tsx";

/** The app's `signInAnonymously` mutation. */
export type SignInAnonymouslyMutation = FunctionReference<
  "mutation",
  "public",
  Record<string, never>,
  ClientView<SignInComplete>
>;

/** Sign in anonymously: `signIn()` starts a session for a new anonymous user. */
export function useSignInAnonymously(api: { signInAnonymously: SignInAnonymouslyMutation }) {
  const signInMutation = useStableFunctionReference(api.signInAnonymously);
  const { setSession } = useAuthActions();
  // Through the sign-in API rather than `useMutation`, so one hook serves both session models.
  const signInApi = useAuthSignInApi();
  const signIn = useCallback(async () => {
    const result = await signInApi.mutation(signInMutation as never, {} as never);
    await setSession((result as ClientView<SignInComplete>).tokens);
  }, [signInApi, signInMutation, setSession]);
  return { signIn };
}
