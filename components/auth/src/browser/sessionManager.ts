// The client's owner of the session (STUDY-201 §1.12), v2's `AuthClient` in bunvex's words (DV-577, C-4): it keeps the
// tokens a sign-in returned, hands out the access token (refreshing under a lock across tabs when asked to), follows
// other tabs, and offers a subscribe/snapshot store any UI framework can read. Two models: in a single-page app ("spa")
// the client holds the refresh token; behind a server-rendering host ("ssr") an httpOnly cookie does. When the token is
// refreshed is the backend client's (`BunvexProviderWithAuth` asks for a forced fetch before `exp`), not this module's.
import type { RefreshResult, SlimTokenBundle, TokenBundle } from "../lib/types.ts";
import type { AmbientSignInClient, AuthSignInApi, BunvexMutationApi } from "./ambientSignInClient.ts";
import { KeyedStore, type SignInValuesReader } from "./keyedStore.ts";
import { runWithMutex } from "./mutex.ts";
import { retryOnNetworkError } from "./retry.ts";
import { JWT_STORAGE_KEY, NamespacedStorage, REFRESH_TOKEN_STORAGE_KEY, type TokenStorage } from "./storage.ts";

/** Refresh and sign-out where the client holds the refresh token: `rotated` carries the next one, `noSession` none. */
export interface SpaAuthApi {
  refreshSession: (refreshToken: string) => Promise<RefreshResult>;
  signOut: (refreshToken: string) => Promise<void>;
}

/**
 * Refresh and sign-out where an httpOnly cookie holds the refresh token: the host reads it, and answers the new access
 * token (`null` when the session is gone).
 */
export interface SsrAuthApi {
  refreshSession: () => Promise<SlimTokenBundle | null>;
  signOut: () => Promise<void>;
}

/** What both models configure. */
interface AuthClientConfigBase {
  /** Where the tokens are kept. */
  storage: TokenStorage;
  /** The storage keys' namespace: usually the deployment's URL. */
  storageNamespace: string;
  /** An access token to store at `init()`, usually a server-rendering host's. */
  initialAccessToken?: string | null;
  /** The ambient sign-ins to set up while the client is built, and what each setup is handed. */
  ambientSignIns?: {
    signIns: ReadonlyArray<AmbientSignInClient>;
    signInApi: AuthSignInApi;
    bunvex: BunvexMutationApi;
    /** Replaces the page's URL without navigating (`history.replaceState`, keeping its state, by default). */
    replaceUrl?: (url: string) => void;
  };
  /** Log the refreshes and the lifecycle to the console. */
  verbose?: boolean;
}

/** An {@link AuthClient}'s configuration, by session model: who holds the refresh token decides the API it drives. */
export type AuthClientConfig =
  | (AuthClientConfigBase & { mode: "spa"; authApi: SpaAuthApi })
  | (AuthClientConfigBase & { mode: "ssr"; authApi: SsrAuthApi });

/** The auth state {@link AuthClient.subscribe} reports. */
export interface AuthState {
  isLoading: boolean;
  isAuthenticated: boolean;
  token: string | null;
}

type Listener = () => void;

/** The state of a client until `init()` loaded the stored session: a binding's snapshot before hydration. */
export const INITIAL_AUTH_STATE: AuthState = Object.freeze({ isLoading: true, isAuthenticated: false, token: null });

/** A session with its refresh token (a {@link TokenBundle}), not an access-only one. */
const hasRefreshToken = (session: TokenBundle | SlimTokenBundle): session is TokenBundle => "refreshToken" in session;

/** A refresh's outcome as this client keeps it, whatever the model: a session to store, or none. */
type RefreshOutcome = { kind: "rotated"; session: TokenBundle | SlimTokenBundle } | { kind: "noSession" };

/** The global `window` when it has DOM events, else null (React Native has a `window` without them). */
function domEventTarget(): Pick<Window, "addEventListener" | "removeEventListener"> | null {
  if (typeof window === "undefined") return null;
  if (typeof window.addEventListener !== "function" || typeof window.removeEventListener !== "function") return null;
  return window;
}

/** Replace the page's URL keeping the history state (routers such as React Router keep theirs there). */
function replaceUrlKeepingState(url: string): void {
  window.history.replaceState(window.history.state, "", url);
}

/**
 * The session on the client, whatever the UI framework: it keeps the tokens a method's sign-in returned (methods
 * authenticate, then call {@link AuthClient.setSession}), hands out the access token ({@link AuthClient.fetchAccessToken},
 * refreshing under a lock across tabs when forced), follows other tabs, and reports its state through
 * {@link AuthClient.subscribe} and {@link AuthClient.getSnapshot}.
 */
export class AuthClient {
  readonly #refresh: () => Promise<RefreshOutcome>;
  readonly #revoke: () => Promise<void>;
  readonly #storage: NamespacedStorage;
  readonly #verbose: boolean;
  readonly #lockKey: string;
  readonly #initialAccessToken: string | null;
  /** Who holds the refresh token: this client ("spa") or a cookie ("ssr"). */
  readonly #mode: "spa" | "ssr";

  #accessToken: string | null = null;
  /** Always null in the "ssr" model. */
  #refreshToken: string | null = null;
  #isLoading = true;
  #pendingSignIns = 0;
  #initialized = false;
  #snapshot: AuthState = INITIAL_AUTH_STATE;
  readonly #listeners = new Set<Listener>();
  #storageListener: ((event: StorageEvent) => void) | null = null;
  /** What ambient sign-ins publish, by their id. */
  readonly #ambientValues = new KeyedStore();
  /** Their `onInit`s, run once by `init()`. */
  readonly #initCallbacks: { id: string; callback: () => void }[] = [];

  constructor(config: AuthClientConfig) {
    this.#storage = new NamespacedStorage(config.storage, config.storageNamespace);
    this.#verbose = config.verbose ?? false;
    this.#lockKey = this.#storage.key(REFRESH_TOKEN_STORAGE_KEY);
    this.#initialAccessToken = config.initialAccessToken ?? null;
    this.#mode = config.mode;
    if (config.mode === "spa") {
      const api = config.authApi;
      this.#refresh = async () => {
        const refreshToken = await this.#currentRefreshToken();
        // No token, no session: nothing to call.
        if (refreshToken === null) return { kind: "noSession" };
        const result = await api.refreshSession(refreshToken);
        return result.kind === "rotated" ? { kind: "rotated", session: result.tokens } : { kind: "noSession" };
      };
      this.#revoke = async () => {
        const refreshToken = await this.#currentRefreshToken();
        if (refreshToken !== null) await api.signOut(refreshToken);
      };
    } else {
      const api = config.authApi;
      // The host reads the refresh token from its cookie, and already wrote the rotated one there.
      this.#refresh = async () => {
        const session = await api.refreshSession();
        return session === null ? { kind: "noSession" } : { kind: "rotated", session };
      };
      this.#revoke = () => api.signOut();
    }
    // Last, so the setups see a built client.
    this.#registerAmbientSignIns(config.ambientSignIns);
  }

  /** Be told when the {@link AuthState} changes (then read {@link getSnapshot}); returns the unsubscribe. */
  subscribe = (listener: Listener): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /** The latest {@link AuthState}. */
  getSnapshot = (): AuthState => this.#snapshot;

  /** The access token, or null. */
  getAccessToken(): string | null {
    return this.#accessToken;
  }

  /** @internal */
  get storage(): NamespacedStorage {
    return this.#storage;
  }

  /** What the ambient sign-in `id` published, read-only, for hooks to read and subscribe to. */
  ambientSignInValues(id: string): SignInValuesReader {
    return this.#ambientValues.forSignInReader(id);
  }

  #registerAmbientSignIns(ambient: AuthClientConfig["ambientSignIns"]): void {
    if (ambient === undefined) return;
    const seen = new Set<string>();
    for (const { id, setup } of ambient.signIns) {
      if (!/^[a-zA-Z0-9]+$/.test(id))
        throw new Error(`Ambient sign-in id "${id}" is invalid; ids must be alphanumeric`);
      if (seen.has(id))
        throw new Error(
          `Ambient sign-in id "${id}" is registered twice; each auth method registers once per BunvexAuthProvider`,
        );
      seen.add(id);
      const registration = setup({
        client: this,
        values: this.#ambientValues.forSignIn(id),
        storage: this.#storage.forSignIn(id),
        signInApi: ambient.signInApi,
        bunvex: ambient.bunvex,
        replaceUrl: ambient.replaceUrl ?? replaceUrlKeepingState,
      });
      if (registration?.onInit !== undefined) this.#initCallbacks.push({ id, callback: registration.onInit });
    }
  }

  /**
   * Run the ambient sign-ins' `onInit`s, load the stored session and follow other tabs; loading until it resolves. The
   * callbacks and the load run once; the tabs' listener is attached on every call, so `init()` after `dispose()`
   * restores the client.
   */
  async init(): Promise<void> {
    this.#attachStorageListener();
    if (this.#initialized) return;
    this.#initialized = true;
    // Before anything is observable, so a `withSignInPending` in one marks loading before the session loads. One that
    // throws is logged and skipped: the others run, and the session loads.
    for (const { id, callback } of this.#initCallbacks) {
      try {
        callback();
      } catch (error) {
        console.error(`[bunvex-auth] onInit for ambient sign-in "${id}" threw:`, error);
      }
    }
    // A token given at start is the freshest: stored before the load reads it back (and for the other tabs).
    if (this.#initialAccessToken !== null) await this.#storage.set(JWT_STORAGE_KEY, this.#initialAccessToken);
    const [accessToken, refreshToken] = await Promise.all([
      this.#storage.get(JWT_STORAGE_KEY),
      this.#storage.get(REFRESH_TOKEN_STORAGE_KEY),
    ]);
    this.#accessToken = accessToken ?? null;
    this.#refreshToken = refreshToken ?? null;
    this.#log(`init: token is null: ${this.#accessToken === null}`);
    this.#isLoading = false;
    this.#notify();
  }

  /**
   * Stop following other tabs. Call it on teardown. Subscribers stay (each leaves through its unsubscribe), so a later
   * `init()` restores the client with them.
   */
  dispose(): void {
    const target = domEventTarget();
    if (this.#storageListener !== null && target !== null) target.removeEventListener("storage", this.#storageListener);
    this.#storageListener = null;
  }

  /**
   * Keep the session a method's sign-in just returned: the full tokens where the client holds the refresh token ("spa"),
   * the access token alone where a cookie does ("ssr").
   */
  setSession = async (session: TokenBundle | SlimTokenBundle): Promise<void> => {
    await this.#adopt(session);
  };

  /**
   * Run a sign-in's completion reporting loading: for one the user did not start on this page (an OAuth callback's code
   * redeemed after a redirect), so the UI shows loading rather than a flash of signed out. Put its `setSession` inside, so
   * loading lasts until the client is signed in.
   */
  withSignInPending = async <T>(fn: () => Promise<T>): Promise<T> => {
    this.#pendingSignIns++;
    this.#notify();
    try {
      return await fn();
    } finally {
      this.#pendingSignIns--;
      this.#notify();
    }
  };

  /** Revoke the session on the server and forget it here. A failed revocation (usually: already signed out) is ignored. */
  signOut = async (): Promise<void> => {
    try {
      await this.#revoke();
    } catch {
      // Usually a session already gone.
    }
    this.#log("signed out, erasing tokens");
    await this.#storeTokens(null);
  };

  /**
   * The access token for `BunvexProviderWithAuth`: the one held (expired or not), or with `forceRefreshToken` a refreshed
   * one, under the refresh lock: if another tab refreshed meanwhile, its token.
   */
  fetchAccessToken = async ({ forceRefreshToken }: { forceRefreshToken: boolean }): Promise<string | null> => {
    if (!forceRefreshToken) return this.#accessToken;
    const before = this.#accessToken;
    return await runWithMutex(this.#lockKey, async () => {
      if (this.#accessToken !== before) {
        this.#log("using token refreshed by another tab");
        return this.#accessToken;
      }
      const outcome = await retryOnNetworkError(
        () => this.#refresh(),
        (message) => this.#log(`refresh: ${message}`),
      );
      if (outcome.kind === "noSession") await this.#storeTokens(null);
      else await this.#adopt(outcome.session);
      return this.#accessToken;
    });
  };

  /** The refresh token to present: the storage's (shared across tabs), else the one in memory. */
  async #currentRefreshToken(): Promise<string | null> {
    return (await this.#storage.get(REFRESH_TOKEN_STORAGE_KEY)) ?? this.#refreshToken;
  }

  /**
   * Keep a session by its shape. A shape that is not the model's is a wiring bug, refused loudly either way: a refresh
   * token in browser storage is what the "ssr" model exists to prevent, and a session without one in "spa" would expire
   * silently at its first access token's end.
   */
  async #adopt(session: TokenBundle | SlimTokenBundle): Promise<void> {
    if (hasRefreshToken(session)) {
      if (this.#mode === "ssr")
        throw new Error(
          "[bunvex-auth] Received a refresh token in an SSR response. The auth proxy did not move it into the httpOnly " +
            "cookie; refusing to persist it in browser storage.",
        );
      await this.#storeTokens(session);
      return;
    }
    if (this.#mode === "spa")
      throw new Error(
        "[bunvex-auth] Received a session with no refresh token in SPA mode. Without one the session cannot be rotated " +
          "and would expire silently.",
      );
    // A refresh token in storage would only be there had a "spa" client become an "ssr" one: dropped.
    this.#refreshToken = null;
    await this.#storage.remove(REFRESH_TOKEN_STORAGE_KEY);
    this.#accessToken = session.accessToken;
    await this.#storage.set(JWT_STORAGE_KEY, session.accessToken);
    this.#isLoading = false;
    this.#notify();
  }

  /** Store both tokens, or with null forget both. */
  async #storeTokens(bundle: TokenBundle | null): Promise<void> {
    this.#accessToken = bundle?.accessToken ?? null;
    this.#refreshToken = bundle?.refreshToken ?? null;
    if (bundle === null) {
      await this.#storage.remove(JWT_STORAGE_KEY);
      await this.#storage.remove(REFRESH_TOKEN_STORAGE_KEY);
    } else {
      await this.#storage.set(JWT_STORAGE_KEY, bundle.accessToken);
      await this.#storage.set(REFRESH_TOKEN_STORAGE_KEY, bundle.refreshToken);
    }
    this.#isLoading = false;
    this.#notify();
  }

  /**
   * Follow other tabs through `storage` events of this storage area: the access token's key sets the token (and
   * notifies), the refresh token's sets it silently. Never written back (that would loop). None on React Native.
   */
  #attachStorageListener(): void {
    const target = domEventTarget();
    if (target === null || this.#storageListener !== null) return;
    const jwtKey = this.#storage.key(JWT_STORAGE_KEY);
    const refreshKey = this.#storage.key(REFRESH_TOKEN_STORAGE_KEY);
    const listener = (event: StorageEvent) => {
      if (event.storageArea !== this.#storage.storage) return;
      if (event.key === jwtKey) {
        this.#accessToken = event.newValue;
        this.#log(`synced access token, is null: ${event.newValue === null}`);
        this.#isLoading = false;
        this.#notify();
      } else if (event.key === refreshKey) this.#refreshToken = event.newValue;
    };
    target.addEventListener("storage", listener);
    this.#storageListener = listener;
  }

  #notify(): void {
    this.#snapshot = {
      // Until the stored session is read, and again while a sign-in's completion is pending.
      isLoading: this.#isLoading || this.#pendingSignIns > 0,
      isAuthenticated: this.#accessToken !== null,
      token: this.#accessToken,
    };
    for (const listener of this.#listeners) listener();
  }

  #log(message: string): void {
    if (this.#verbose) console.debug(`${new Date().toISOString()} [bunvex-auth] ${message}`);
  }
}
