// A sign-in API for the hooks' tests (upstream's `react/testSignInApi.ts`): the methods' hooks run their sign-in
// function through it rather than `useMutation`, so a test substitutes it, the mock standing for the backend's call.
import { mock } from "bun:test";
import type { AuthSignInApi } from "../src/browser/ambientSignInClient.ts";

export function stubSignInApi(): { signInApi: AuthSignInApi; run: ReturnType<typeof mock> } {
  const run = mock();
  const signInApi = {
    mutation: (_fn: unknown, args: unknown) => run(args),
    action: (_fn: unknown, args: unknown) => run(args),
  } as unknown as AuthSignInApi;
  return { signInApi, run };
}
