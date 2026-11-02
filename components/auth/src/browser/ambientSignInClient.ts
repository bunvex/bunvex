// The contract between the core client and ambient sign-ins (STUDY-201 §1.12), v2's in bunvex's words (C-4): a sign-in
// that runs at the client's start, not because the app called it. OAuth is one: the user comes back from the identity
// provider to a page that never called a sign-in hook, and the client must notice and finish it. They are registered
// whether the app uses them or not, so their start must return at once unless it finds a flow of its own.
//
// A method exports a factory (`oauth()`) making an {@link AmbientSignInClient}, which the app passes to the provider's
// `ambientSignIns`. Its `id` names the method and scopes its values and storage. Two phases, both the client's:
// 1. setup, synchronous, while the `AuthClient` is built: register actions and starting values, so they exist before
//    the app's first render reads them;
// 2. `onInit`, if setup returns one, inside the client's `init()`, once per client, before the stored session loads:
//    side effects (an OAuth callback URL). Wrap a sign-in it finishes in `withSignInPending`, synchronously, so the
//    state reads loading rather than briefly signed out.
// The backend's types only: this keeps the logic free of any one client class, so non-React bindings drive it too.
import type { FunctionArgs, FunctionReference, FunctionReturnType } from "@bunvex/server";
import type { ClientView, SignInEnvelope } from "../lib/types.ts";
import type { SignInValues } from "./keyedStore.ts";
import type { AuthClient } from "./sessionManager.ts";
import type { SignInStorage } from "./storage.ts";

/**
 * A public function returning the shared sign-in result, as the client sees it (`ClientView`). Only its return type is
 * constrained, so a client still infers its optional arguments.
 */
export type SignInFunction<Type extends "mutation" | "action"> = FunctionReference<Type, "public"> & {
  _returnType: ClientView<SignInEnvelope>;
};

/**
 * How a method's sign-in functions are run: against the deployment in a single-page app (the full tokens come back for
 * the client to keep), through the server-rendering host's auth proxy otherwise (the refresh token stays there). A method
 * never knows which. Only functions returning the shared sign-in result are accepted (the proxy refuses any other); a
 * function that starts no session goes through {@link BunvexMutationApi}. Calls are retried on network errors, so a
 * sign-in function must bear running again after an attempt that committed.
 */
export interface AuthSignInApi {
  mutation<F extends SignInFunction<"mutation">>(fn: F, args: FunctionArgs<F>): Promise<FunctionReturnType<F>>;
  action<F extends SignInFunction<"action">>(fn: F, args: FunctionArgs<F>): Promise<FunctionReturnType<F>>;
}

/** How an ambient sign-in calls its public mutations that start no session (starting an OAuth flow): the deployment's. */
export interface BunvexMutationApi {
  mutation<F extends FunctionReference<"mutation", "public">>(
    fn: F,
    args: FunctionArgs<F>,
  ): Promise<FunctionReturnType<F>>;
}

/** What an ambient sign-in's setup receives. */
export type AmbientSignInContext = {
  /** The client it registers into. */
  client: AuthClient;
  /** What it publishes for hooks to read (its actions, its last attempt's status); gone on reload. */
  values: SignInValues;
  /** Its own storage, kept across reloads. */
  storage: SignInStorage;
  /** Runs the method's sign-in functions (only those returning the shared sign-in result). */
  signInApi: AuthSignInApi;
  /** Runs the method's other public mutations. */
  bunvex: BunvexMutationApi;
  /** Replaces the page's URL without navigating; use it instead of `history.replaceState`, so a router keeps up. */
  replaceUrl: (url: string) => void;
};

/** An ambient sign-in's registration, passed in the provider's `ambientSignIns`, set up while the client is built. */
export type AmbientSignInClient = {
  /** The method's unique name (e.g. `"oauth"`), letters and digits only; an invalid or repeated id throws. */
  id: string;
  /** The setup, run while the client is built; it may return an `onInit` to run in `init()`. */
  setup: (ctx: AmbientSignInContext) => void | { onInit?: () => void };
};
