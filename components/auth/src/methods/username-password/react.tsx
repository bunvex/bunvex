// The username + password method's React hooks (STUDY-201 §1.11), v2's: each runs its mutation through the provider's
// sign-in API, keeps the session a completed one returns, and folds a thrown call into `OTHER_ERROR` (so a caller handles
// every outcome in one switch), with `pending` while it runs.
"use client";

import type { FunctionReference } from "@bunvex/server";
import { useCallback, useState } from "react";
import type { ClientView } from "../../lib/types.ts";
import { useAuthSignInApi } from "../../react/client.tsx";
import { useStableFunctionReference } from "../../react/functionReference.ts";
import { useAuthActions } from "../../react/index.tsx";
import type { SignInResult, SignUpResult } from "./server.ts";

/** A username and a password. */
export type Credentials = { username: string; password: string };

type SignInMutation = FunctionReference<"mutation", "public", Credentials, ClientView<SignInResult>>;
type SignUpMutation = FunctionReference<"mutation", "public", Credentials, ClientView<SignUpResult>>;

/** A call that threw (a network failure, an app error), folded into the result. */
type UnexpectedFailure = { status: "error"; userError: { error: "OTHER_ERROR"; cause: unknown } };

/** What `signIn` resolves to: the method's result, or `OTHER_ERROR` with what was thrown. */
export type SignInWithUsernamePasswordResult = ClientView<SignInResult> | UnexpectedFailure;
/** What `signUp` resolves to: the method's result, or `OTHER_ERROR` with what was thrown. */
export type SignUpWithUsernamePasswordResult = ClientView<SignUpResult> | UnexpectedFailure;

/** Sign in with a username and a password: `signIn(credentials)`, and `pending` while it runs. */
export function useSignInWithUsernamePassword(api: { signInWithUsernamePassword: SignInMutation }) {
  const { run, pending } = usePasswordFlow(useStableFunctionReference(api.signInWithUsernamePassword));
  return {
    /**
     * Sign in with these credentials. `status` is `"complete"` once signed in (the client then authenticates with the
     * deployment), or `"error"`, with why in `userError`.
     */
    signIn: run,
    /** Whether the sign-in is being checked. */
    pending,
  };
}

/** Sign up with a username and a password: `signUp(credentials)`, and `pending` while it runs. */
export function useSignUpWithUsernamePassword(api: { signUpWithUsernamePassword: SignUpMutation }) {
  const { run, pending } = usePasswordFlow(useStableFunctionReference(api.signUpWithUsernamePassword));
  return {
    /**
     * Sign up with these credentials. `status` is `"complete"` once signed up and in (the client then authenticates
     * with the deployment), or `"error"`, with why in `userError`.
     */
    signUp: run,
    /** Whether the sign-up is being checked. */
    pending,
  };
}

function usePasswordFlow<Result extends ClientView<SignInResult> | ClientView<SignUpResult>>(
  mutation: FunctionReference<"mutation", "public", Credentials, Result>,
) {
  const { setSession } = useAuthActions();
  const signInApi = useAuthSignInApi();
  const [pending, setPending] = useState(false);
  const run = useCallback(
    async (credentials: Credentials): Promise<Result | UnexpectedFailure> => {
      setPending(true);
      try {
        const result = (await signInApi.mutation(mutation as never, credentials as never)) as Result;
        if (result.status === "complete") await setSession(result.tokens);
        return result;
      } catch (cause) {
        return { status: "error", userError: { error: "OTHER_ERROR", cause } };
      } finally {
        setPending(false);
      }
    },
    [signInApi, mutation, setSession],
  );
  return { run, pending };
}
