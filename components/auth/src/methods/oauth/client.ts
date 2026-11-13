// The OAuth providers' browser client (STUDY-201 C-5), v2's `methods/oauth/client.ts` in bunvex's words: the core's
// provider registers it by default, inert until a callback URL carries its parameters. A sign-in spans a page round
// trip: starting one saves the `state` the server gave before navigating away; the callback's `code` is redeemed with
// it at the next start, which proves this browser began the flow. Starting returns a redirect, not a session, so it runs
// on the plain backend client; only the redemption, which returns the shared sign-in result, runs on the sign-in API
// (the auth proxy under server rendering). The OAuth providers' server side comes with OAuth itself.
import { type FunctionReference, getFunctionName, makeFunctionReference } from "@bunvex/server";
import type { AmbientSignInClient } from "../../browser/ambientSignInClient.ts";
import { retryOnNetworkError } from "../../browser/retry.ts";
import type { SignInStorage } from "../../browser/storage.ts";
import { OAUTH_CODE_PARAM, OAUTH_ERROR_PARAM } from "../../lib/oauthParams.ts";
import type { ClientView, SignInComplete, SignInError } from "../../lib/types.ts";

/** What a provider's `completeSignIn` returns: a session, or a code that did not redeem (one code for every reason). */
type CompleteSignInResult = SignInComplete | SignInError<{ error: "INVALID_CODE" }>;

/** The mutations an OAuth provider's method adds to the app, as references (an app may export them under any name). */
export type OauthProviderApi = {
  /** The provider's `startSignIn*` mutation. */
  startSignIn: FunctionReference<"mutation", "public", { redirectTo: string }, { redirect: string; state: string }>;
  /** The provider's `completeSignIn*` mutation. */
  completeSignIn: FunctionReference<
    "mutation",
    "public",
    { code: string; state: string },
    ClientView<CompleteSignInResult>
  >;
};

/** A provider's mutations and its name. */
export type OauthProviderRefs = {
  /** The provider's name, e.g. `"google"`: a label, never looked up. */
  providerName: string;
} & OauthProviderApi;

/**
 * Why a flow failed after the identity provider sent the user back. The callback lands on a page load nobody waits on,
 * so the hooks report it as `flowError`; apps switch on `error` and word each code themselves.
 *
 * - `ACCESS_DENIED`: the user cancelled at the identity provider.
 * - `EXPIRED`: the flow took too long, or its code was already redeemed.
 * - `INVALID_FLOW`: a callback arrived, but this client saved no flow (it never started it, or already finished it).
 * - `OTHER_ERROR`: anything else (the identity provider failing, the redemption throwing); `cause` is what was thrown,
 *   or the error the callback URL carried. When the app's backend refuses the sign-in by throwing a `BunvexError` (from
 *   `onSignIn`, say), `cause` is that `BunvexError`, as with the other sign-in methods.
 */
export type OauthFlowError =
  | { error: "ACCESS_DENIED" }
  | { error: "EXPIRED" }
  | { error: "INVALID_FLOW" }
  | { error: "OTHER_ERROR"; cause: unknown };

/**
 * What starting a flow resolves to: the identity provider's URL, or `OTHER_ERROR` with what was thrown, so a caller
 * handles every outcome in one switch. It rejects only without a `redirectTo` where there is no page URL (a bug in the
 * caller). On the web the client navigates to `redirect` itself; React Native opens it in an in-app browser.
 */
export type OauthStartResult =
  | { status: "redirect"; redirect: URL }
  | { status: "error"; userError: { error: "OTHER_ERROR"; cause: unknown } };

/** What finishing a saved flow with a callback `code` resolves to; it never rejects. */
export type OauthCompleteResult = { status: "complete" } | { status: "error"; userError: OauthFlowError };

/** The options of {@link OauthActions.signIn}. */
export type SignInOptions = {
  /**
   * Where the flow comes back to: the current URL by default, required where there is none (React Native). An http or
   * https URL; custom schemes (`myapp://`) are not supported yet.
   */
  redirectTo?: string;
  /** A callback `code` to finish a saved flow with, instead of starting one. */
  code?: string;
};

/** The actions {@link oauth} publishes for its hooks. */
export type OauthActions = {
  /**
   * Start a provider's flow (navigating away to the identity provider), or with `options.code` finish a saved one.
   * Resolves to an {@link OauthStartResult}, or with a `code` an {@link OauthCompleteResult}.
   */
  signIn: (refs: OauthProviderRefs, options?: SignInOptions) => Promise<OauthStartResult | OauthCompleteResult>;
};

/** The id {@link oauth} registers under. */
export const OAUTH_SETUP_ID = "oauth";
/** The key its {@link OauthActions} are published under. */
export const OAUTH_ACTIONS_KEY = "actions";
/**
 * The key of the current {@link OauthFlowError}, null when the last attempt was fine. Set at registration, so
 * `undefined` means {@link oauth} was never registered.
 */
export const OAUTH_FLOW_ERROR_KEY = "flowError";
/** The storage key of the saved flow. */
const FLOW_KEY = "flow";

/** What `signIn` saves before navigating to the identity provider. */
export type PendingFlow = {
  /** The provider the flow is for. */
  providerName: string;
  /** The `state` the server gave at the start: the proof this client began the flow. */
  state: string;
  /**
   * The path of the provider's `completeSignIn` (`getFunctionName`): the flow may come back to a page that never held
   * the reference, so it is rebuilt from the path. Renamed and redeployed mid-flight, it no longer resolves, and the
   * sign-in fails as `OTHER_ERROR`.
   */
  completeSignIn: string;
};

/** The error the server put in the callback URL (`access_denied`, `expired`; anything else as `oauth_error`). */
function callbackFlowError(param: string): OauthFlowError {
  if (param === "access_denied") return { error: "ACCESS_DENIED" };
  if (param === "expired") return { error: "EXPIRED" };
  return { error: "OTHER_ERROR", cause: param };
}

/** The page's URL, or null without one (React Native has a `window` but no `window.location`). */
function currentHref(): string | null {
  if (typeof window === "undefined" || window.location === undefined) return null;
  return window.location.href;
}

/**
 * Read and remove the saved flow. Removed even if the redemption that follows fails: the code it pairs with is
 * one-time anyway.
 */
async function takePendingFlow(storage: SignInStorage): Promise<PendingFlow | null> {
  const raw = await storage.get(FLOW_KEY);
  await storage.remove(FLOW_KEY);
  if (raw === null || raw === undefined) return null;
  try {
    const flow = JSON.parse(raw) as Partial<Record<keyof PendingFlow, unknown>>;
    if (
      typeof flow.providerName !== "string" ||
      typeof flow.state !== "string" ||
      typeof flow.completeSignIn !== "string"
    )
      return null;
    return { providerName: flow.providerName, state: flow.state, completeSignIn: flow.completeSignIn };
  } catch {
    return null;
  }
}

/** Remove the saved flow once it ended; not awaited, so a failed removal is ignored (the failure was recorded). */
async function dropPendingFlow(storage: SignInStorage): Promise<void> {
  try {
    await storage.remove(FLOW_KEY);
  } catch {
    // The flow was over anyway.
  }
}

/**
 * The OAuth providers' client setup: it owns the flow's storage and the start's work that finishes a flow. Each
 * `signIn` call brings the provider's mutations, so it takes no configuration.
 */
export function oauth(): AmbientSignInClient {
  const setup: AmbientSignInClient["setup"] = ({ client, values, storage, signInApi, bunvex, replaceUrl }) => {
    const setFlowError = (flowError: OauthFlowError | null) => values.set(OAUTH_FLOW_ERROR_KEY, flowError);

    /**
     * Redeem a callback `code` with the saved flow and keep the session. It never rejects (callers that do not await it
     * are safe); callers run it in `withSignInPending` with what they do with the result, so the state stays loading
     * until signed in or the failure is recorded.
     */
    const redeem = async (code: string): Promise<OauthCompleteResult> => {
      try {
        const flow = await takePendingFlow(storage);
        if (flow === null) return { status: "error", userError: { error: "INVALID_FLOW" } };
        const completeSignIn = makeFunctionReference<"mutation">(
          flow.completeSignIn,
        ) as OauthProviderApi["completeSignIn"];
        const result = await retryOnNetworkError(() => signInApi.mutation(completeSignIn, { code, state: flow.state }));
        // Unknown, already redeemed, expired and mismatched states are one answer to the server.
        if (result.status === "error") return { status: "error", userError: { error: "EXPIRED" } };
        await client.setSession(result.tokens);
        return { status: "complete" };
      } catch (error) {
        // v2 (3ad61bd9): the app's `BunvexError` too, as `cause`.
        return { status: "error", userError: { error: "OTHER_ERROR", cause: error } };
      }
    };

    /**
     * Finish a flow the callback came back with. Its parameters are read and stripped from the URL before the first
     * await, so a second run finds a clean URL and does nothing; only this client's parameters are touched.
     */
    const handleCallback = (): void => {
      const href = currentHref();
      if (href === null) return;
      const url = new URL(href);
      const code = url.searchParams.get(OAUTH_CODE_PARAM);
      const errorParam = url.searchParams.get(OAUTH_ERROR_PARAM);
      if (code === null && errorParam === null) return;
      url.searchParams.delete(OAUTH_CODE_PARAM);
      url.searchParams.delete(OAUTH_ERROR_PARAM);
      replaceUrl(url.toString());
      if (errorParam !== null) {
        // The server ended the flow: its state is spent. Dropped now, so a stray code later still reads INVALID_FLOW.
        void dropPendingFlow(storage);
        setFlowError(callbackFlowError(errorParam));
        return;
      }
      if (code === null) return;
      // Nothing waits on a page load: a failure is published for the hooks, before the pending sign-in ends, so the
      // state never reads signed out and loaded without the error that explains it.
      void client.withSignInPending(async () => {
        const result = await redeem(code);
        if (result.status === "error") setFlowError(result.userError);
      });
    };

    const signIn: OauthActions["signIn"] = async (refs, options) => {
      const code = options?.code;
      if (code !== undefined) {
        setFlowError(null);
        return await client.withSignInPending(() => redeem(code));
      }
      const href = currentHref();
      const redirectTo = options?.redirectTo ?? href;
      if (redirectTo === null)
        throw new Error("`redirectTo` is required where there is no current page URL, such as React Native.");
      // Cleared here, not first: a call that throws above leaves an error the app shows alone.
      setFlowError(null);
      try {
        const { redirect, state } = await bunvex.mutation(refs.startSignIn, { redirectTo });
        await storage.set(
          FLOW_KEY,
          JSON.stringify({
            providerName: refs.providerName,
            state,
            completeSignIn: getFunctionName(refs.completeSignIn),
          } satisfies PendingFlow),
        );
        const url = new URL(redirect);
        // No page to leave on React Native: it gets the URL, opens it in an in-app browser, and finishes with
        // `signIn(refs, { code })`.
        if (href !== null && navigator.product !== "ReactNative") window.location.href = url.toString();
        return { status: "redirect", redirect: url };
      } catch (cause) {
        // A caller waits on this one: the failure goes back to it, not into the flow error.
        return { status: "error", userError: { error: "OTHER_ERROR", cause } };
      }
    };

    values.set(OAUTH_ACTIONS_KEY, { signIn } satisfies OauthActions);
    setFlowError(null);
    return { onInit: handleCallback };
  };
  return { id: OAUTH_SETUP_ID, setup };
}
