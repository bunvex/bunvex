// What the OAuth client's suites share (upstream's `methods/oauth/testFlow.ts`): a client with the real `oauth()` setup,
// mocks for the two backend calls (the sign-in API that completes a flow, the plain mutation that starts one), a stand-in
// provider, and the saved flow's storage.
import { mock } from "bun:test";
import { getFunctionName, makeFunctionReference } from "@bunvex/server";
import type { AuthSignInApi } from "../src/browser/ambientSignInClient.ts";
import { AuthClient } from "../src/browser/sessionManager.ts";
import { InMemoryStorage, NamespacedStorage, type TokenStorage } from "../src/browser/storage.ts";
import type { TokenBundle } from "../src/lib/types.ts";
import {
  OAUTH_ACTIONS_KEY,
  OAUTH_FLOW_ERROR_KEY,
  OAUTH_SETUP_ID,
  type OauthActions,
  type OauthFlowError,
  type OauthProviderRefs,
  oauth,
  type PendingFlow,
} from "../src/methods/oauth/client.ts";

/** The deployment URL the storage is namespaced by. */
export const NAMESPACE = "https://happy-animal-123.bunvex.example";

/** A session for the sign-in mutation to resolve with. */
export const bundle: TokenBundle = {
  accessToken: "access-1",
  refreshToken: "refresh-1",
  refreshTokenExpiresAt: 0,
  userId: "user-1",
};

/** What `completeSignIn` returns once a code redeems. */
export const completed = { status: "complete" as const, tokens: bundle };

/** What `completeSignIn` returns for a code that does not redeem (unknown, spent, expired, someone else's state). */
export const invalidCode = { status: "error" as const, userError: { error: "INVALID_CODE" as const } };

/**
 * A stand-in provider. Its paths look like an app's: `signIn` saves `completeSignIn`'s path, and completing rebuilds the
 * reference from it, so tests compare paths, not references.
 */
export const acmeRefs: OauthProviderRefs = {
  providerName: "acme",
  startSignIn: makeFunctionReference<"mutation">("auth:startSignInAcme") as never,
  completeSignIn: makeFunctionReference<"mutation">("auth:completeSignInAcme") as never,
};

/** The oauth setup's storage over `storage`. */
export const flowStorage = (storage: TokenStorage) =>
  new NamespacedStorage(storage, NAMESPACE).forSignIn(OAUTH_SETUP_ID);

/** The saved flow, or null (a synchronous storage only: the read is not awaited). */
export function readFlow(storage: TokenStorage): PendingFlow | null {
  const raw = flowStorage(storage).get("flow") as string | null | undefined;
  return raw === null || raw === undefined ? null : (JSON.parse(raw) as PendingFlow);
}

/** Save a flow as `signIn` would before navigating away. */
export function seedPendingFlow(storage: TokenStorage, refs: OauthProviderRefs = acmeRefs, state = "state-1"): void {
  void flowStorage(storage).set(
    "flow",
    JSON.stringify({
      providerName: refs.providerName,
      state,
      completeSignIn: getFunctionName(refs.completeSignIn),
    } satisfies PendingFlow),
  );
}

/** A client with `oauth()` registered, its actions and its flow error. */
export function setupOAuth({ storage = new InMemoryStorage() as TokenStorage } = {}) {
  const mutation = mock();
  const signInApi = { mutation, action: mock() } as unknown as AuthSignInApi;
  const bunvexMutation = mock();
  const client = new AuthClient({
    mode: "spa",
    authApi: { refreshSession: async () => ({ kind: "noSession" as const }), signOut: async () => {} },
    storage,
    storageNamespace: NAMESPACE,
    ambientSignIns: { signIns: [oauth()], signInApi, bunvex: { mutation: bunvexMutation } },
  });
  const values = client.ambientSignInValues(OAUTH_SETUP_ID);
  const actions = values.get<OauthActions>(OAUTH_ACTIONS_KEY)!;
  const flowError = () => values.get<OauthFlowError | null>(OAUTH_FLOW_ERROR_KEY);
  return { client, mutation, bunvexMutation, actions, flowError, storage };
}

/** The function path `mutation` was called with. */
export const calledPath = (mutation: ReturnType<typeof mock>, call = 0) =>
  getFunctionName(mutation.mock.calls[call]![0] as never);

/** Until `check` stops throwing (vitest's `waitFor`): a second at most. */
export async function waitFor(check: () => void, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      check();
      return;
    } catch (e) {
      if (Date.now() > deadline) throw e;
      await new Promise((r) => setTimeout(r, 5));
    }
  }
}

/** Take the React Native branch (the redirect returned, not navigated to): happy-dom has a location. */
export function stubReactNative(): void {
  Object.defineProperty(window.navigator, "product", { value: "ReactNative", configurable: true });
}

/** Undo {@link stubReactNative}: the own property gone, the prototype's shows again. */
export function restoreNavigatorProduct(): void {
  delete (window.navigator as { product?: string }).product;
}
