// The client side of authentication, as Convex's `browser/sync/authentication_manager.ts` (STUDY-27 §1.6).
// The server is the source of truth: a token counts once a Transition advances the identity version.
//   1. `setAuth`: pause the socket, fetch a possibly cached token, send it, resume.
//   2. Once the server confirms it, fetch a fresh one (unless `initialAuthTokenReuse`), and confirm that.
//   3. Refetch before the fresh token expires (`exp − leeway`).
// An `AuthError` stops the socket, force-refreshes the token and reconnects; after 2 failed confirmations of
// fresh tokens (or with no token to fetch) auth is cleared and `onChange(false)` reports it.
import type { v1 } from "@bunvex/protocol";
import type { LocalSyncState } from "./local-state.ts";
import type { Logger } from "./logging.ts";

/** `setTimeout` takes a 32-bit delay (about 24 days): refetches are scheduled at most this far ahead. */
const MAXIMUM_REFRESH_DELAY = 20 * 24 * 60 * 60 * 1000;
const MAX_TOKEN_CONFIRMATION_ATTEMPTS = 2;

/**
 * An async function returning a JWT (an OpenID Connect ID token, or a custom JWT, per the server's auth
 * config), or null / undefined when there is none. `forceRefreshToken` is true when the server refused the
 * last token or it is about to expire: the token must not come from a cache.
 */
export type AuthTokenFetcher = (args: { forceRefreshToken: boolean }) => Promise<string | null | undefined>;

type AuthConfig = {
  fetchToken: AuthTokenFetcher;
  onAuthChange: (isAuthenticated: boolean) => void;
  onRefreshChange?: ((isRefreshing: boolean) => void) | undefined;
};

type AuthState =
  | { state: "noAuth" }
  | { state: "waitingForServerConfirmationOfCachedToken"; config: AuthConfig; hasRetried: boolean }
  | { state: "initialRefetch"; config: AuthConfig }
  | { state: "waitingForServerConfirmationOfFreshToken"; config: AuthConfig; hadAuth: boolean; token: string }
  | { state: "waitingForScheduledRefetch"; config: AuthConfig; refetchTokenTimeoutId: ReturnType<typeof setTimeout> }
  // A valid token, but no new one could be fetched.
  | { state: "notRefetching"; config: AuthConfig };

export type AuthenticationCallbacks = {
  /** Send the token as `Authenticate`. */
  authenticate: (token: string) => v1.IdentityVersion;
  stopSocket: () => Promise<void>;
  tryRestartSocket: () => void;
  pauseSocket: () => void;
  resumeSocket: () => void;
  clearAuth: () => void;
};

/** A JWT's payload, decoded without verifying it (the server verifies), or null when it is not a JWT. */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const part = token.split(".")[1];
  if (part === undefined) return null;
  try {
    const b64 = part
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(part.length / 4) * 4, "=");
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const payload: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return typeof payload === "object" && payload !== null && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export class AuthenticationManager {
  private authState: AuthState = { state: "noAuth" };
  /** Bumped by every fetch, `setConfig` and `stop`: a fetch that returns after another began is discarded. */
  private configVersion = 0;
  private lastRefreshChange = false;
  /** Failed confirmations of the latest fresh token, up to MAX_TOKEN_CONFIRMATION_ATTEMPTS. */
  private tokenConfirmationAttempts = 0;

  constructor(
    private readonly syncState: LocalSyncState,
    private readonly callbacks: AuthenticationCallbacks,
    private readonly config: { refreshTokenLeewaySeconds: number; logger: Logger; initialAuthTokenReuse: boolean },
  ) {}

  private get logger() {
    return this.config.logger;
  }

  private notifyRefreshChange(isRefreshing: boolean) {
    const s = this.authState;
    if (s.state === "noAuth" || s.state === "initialRefetch") return;
    if (s.config.onRefreshChange && this.lastRefreshChange !== isRefreshing) {
      this.lastRefreshChange = isRefreshing;
      s.config.onRefreshChange(isRefreshing);
    }
  }

  async setConfig(
    fetchToken: AuthTokenFetcher,
    onChange: (isAuthenticated: boolean) => void,
    onRefreshChange?: (isRefreshing: boolean) => void,
  ) {
    this.resetAuthState();
    this.logVerbose("pausing WS for auth token fetch");
    this.callbacks.pauseSocket();
    const token = await this.fetchTokenAndGuardAgainstRace(fetchToken, { forceRefreshToken: false });
    if (token.isFromOutdatedConfig) return;
    const config: AuthConfig = { fetchToken, onAuthChange: onChange, onRefreshChange };
    if (token.value) {
      this.setAuthState({ state: "waitingForServerConfirmationOfCachedToken", config, hasRetried: false });
      this.callbacks.authenticate(token.value);
    } else {
      this.setAuthState({ state: "initialRefetch", config });
      await this.refetchToken(); // again, with forceRefreshToken: true
    }
    this.logVerbose("resuming WS after auth token fetch");
    this.callbacks.resumeSocket();
  }

  onTransition(m: v1.Transition) {
    // Stale: the client has moved on to a newer identity.
    if (!this.syncState.isCurrentOrNewerAuthVersion(m.endVersion.identity)) return;
    // Not an answer to Authenticate.
    if (m.endVersion.identity <= m.startVersion.identity) return;
    this.logVerbose(`auth state is ${this.authState.state} when handling transition`);
    // The identity advanced: the token was valid, and client and server agree.
    this.syncState.markAuthCompletion();
    const s = this.authState;
    if (s.state === "waitingForServerConfirmationOfCachedToken") {
      this.logVerbose("server confirmed auth token is valid");
      const cached = this.syncState.getAuth()?.value;
      if (this.config.initialAuthTokenReuse && cached) this.scheduleTokenRefetch(cached, m.clientClockSkew);
      else void this.refetchToken();
      s.config.onAuthChange(true);
      return;
    }
    if (s.state === "waitingForServerConfirmationOfFreshToken") {
      this.logVerbose("server confirmed new auth token is valid");
      this.notifyRefreshChange(false);
      this.scheduleTokenRefetch(s.token);
      this.tokenConfirmationAttempts = 0;
      // As Convex: `hadAuth` is read from the state *after* scheduling, which replaced it, so whenever a
      // refetch was scheduled `onChange(true)` runs again (on every refresh). Apps see it; kept the same.
      const now = this.authState as AuthState;
      if (!(now.state === "waitingForServerConfirmationOfFreshToken" && now.hadAuth)) s.config.onAuthChange(true);
    }
  }

  onAuthError(m: v1.AuthError) {
    // An error that is not about a token update (an identity that expired), while one is being confirmed.
    if (
      m.authUpdateAttempted === false &&
      (this.authState.state === "waitingForServerConfirmationOfFreshToken" ||
        this.authState.state === "waitingForServerConfirmationOfCachedToken")
    ) {
      this.logVerbose("ignoring non-auth token expired error");
      return;
    }
    // For an older identity than the client's (the error names the version it did not advance from: + 1).
    if (!this.syncState.isCurrentOrNewerAuthVersion(m.baseVersion + 1)) {
      this.logVerbose("ignoring auth error for previous auth attempt");
      return;
    }
    void this.tryToReauthenticate(m);
  }

  /** As `refetchToken`, but the socket is stopped meanwhile, so mutations do not retry with a bad token. */
  private async tryToReauthenticate(m: v1.AuthError) {
    this.logVerbose(`attempting to reauthenticate: ${m.error}`);
    if (
      this.authState.state === "noAuth" ||
      (this.authState.state === "waitingForServerConfirmationOfFreshToken" &&
        this.tokenConfirmationAttempts >= MAX_TOKEN_CONFIRMATION_ATTEMPTS)
    ) {
      this.logger.error(`Failed to authenticate: "${m.error}", check your server auth config`);
      if (this.syncState.hasAuth()) this.syncState.clearAuth();
      if (this.authState.state !== "noAuth") this.setAndReportAuthFailed(this.authState.config.onAuthChange);
      return;
    }
    if (this.authState.state === "waitingForServerConfirmationOfFreshToken") {
      this.tokenConfirmationAttempts++;
      this.logVerbose(
        `retrying reauthentication, ${MAX_TOKEN_CONFIRMATION_ATTEMPTS - this.tokenConfirmationAttempts} attempts remaining`,
      );
    }
    this.notifyRefreshChange(true);
    await this.callbacks.stopSocket();
    const s = this.authState as AuthState;
    if (s.state === "noAuth") return; // setConfig() or stop() ran meanwhile
    const token = await this.fetchTokenAndGuardAgainstRace(s.config.fetchToken, { forceRefreshToken: true });
    if (token.isFromOutdatedConfig) return;
    if (token.value && this.syncState.isNewAuth(token.value)) {
      this.callbacks.authenticate(token.value);
      this.setAuthState({
        state: "waitingForServerConfirmationOfFreshToken",
        config: s.config,
        token: token.value,
        hadAuth: s.state === "notRefetching" || s.state === "waitingForScheduledRefetch",
      });
    } else {
      this.logVerbose("reauthentication failed, could not fetch a new token");
      if (this.syncState.hasAuth()) this.syncState.clearAuth();
      this.setAndReportAuthFailed(s.config.onAuthChange);
    }
    this.callbacks.tryRestartSocket();
  }

  /** Fetch a fresh token and confirm it; its confirmation schedules the next refetch before it expires. */
  private async refetchToken() {
    const s = this.authState;
    if (s.state === "noAuth") return;
    this.logVerbose("refetching auth token");
    const token = await this.fetchTokenAndGuardAgainstRace(s.config.fetchToken, { forceRefreshToken: true });
    if (token.isFromOutdatedConfig) return;
    if (token.value) {
      if (this.syncState.isNewAuth(token.value)) {
        this.setAuthState({
          state: "waitingForServerConfirmationOfFreshToken",
          hadAuth: this.syncState.hasAuth(),
          token: token.value,
          config: s.config,
        });
        this.callbacks.authenticate(token.value);
      } else {
        this.setAuthState({ state: "notRefetching", config: s.config });
      }
    } else {
      this.logVerbose("refetching token failed");
      if (this.syncState.hasAuth()) this.callbacks.clearAuth();
      this.setAndReportAuthFailed(s.config.onAuthChange);
    }
    // In case a scheduled refetch ran during a reauthentication, which stopped the socket.
    this.logVerbose("restarting WS after auth token fetch (if currently stopped)");
    this.callbacks.tryRestartSocket();
  }

  private scheduleTokenRefetch(token: string, clientClockSkewMs?: number | null) {
    if (this.authState.state === "noAuth") return;
    const decoded = decodeJwtPayload(token);
    if (!decoded) {
      this.logger.error("Auth token is not a valid JWT, cannot refetch the token");
      return;
    }
    const { iat, exp } = decoded as { iat?: number; exp?: number };
    if (!iat || !exp) {
      this.logger.error("Auth token does not have required fields, cannot refetch the token");
      return;
    }
    const fullLifetimeSeconds = exp - iat;
    if (fullLifetimeSeconds <= 2) {
      this.logger.error("Auth token does not live long enough, cannot refetch the token");
      return;
    }
    // A cached token: what remains of it on the server's clock (skew = client − server). A fresh one: all of it.
    const validitySeconds =
      clientClockSkewMs !== undefined && clientClockSkewMs !== null
        ? Math.max(0, exp - (Date.now() - clientClockSkewMs) / 1000)
        : fullLifetimeSeconds;
    const leeway = this.config.refreshTokenLeewaySeconds;
    let delay = Math.min(MAXIMUM_REFRESH_DELAY, (validitySeconds - leeway) * 1000);
    if (delay <= 0) {
      this.logger.warn(
        `Refetching auth token immediately, configured leeway ${leeway}s is larger than the token's lifetime ${validitySeconds}s`,
      );
      delay = 0;
    }
    const refetchTokenTimeoutId = setTimeout(() => {
      this.logVerbose("running scheduled token refetch");
      void this.refetchToken();
    }, delay);
    this.setAuthState({ state: "waitingForScheduledRefetch", refetchTokenTimeoutId, config: this.authState.config });
    this.logVerbose(`scheduled preemptive auth token refetching in ${delay}ms`);
  }

  private async fetchTokenAndGuardAgainstRace(fetchToken: AuthTokenFetcher, args: { forceRefreshToken: boolean }) {
    const version = ++this.configVersion;
    this.logVerbose(`fetching token with config version ${version}`);
    const value = await fetchToken(args);
    if (this.configVersion !== version) {
      this.logVerbose(`stale config version, expected ${version}, got ${this.configVersion}`);
      return { isFromOutdatedConfig: true as const };
    }
    return { isFromOutdatedConfig: false as const, value };
  }

  stop() {
    this.resetAuthState();
    this.configVersion++; // discard a fetch in progress
    this.logVerbose(`config version bumped to ${this.configVersion}`);
  }

  private setAndReportAuthFailed(onAuthChange: (isAuthenticated: boolean) => void) {
    onAuthChange(false);
    this.resetAuthState();
  }

  /** The only way to `noAuth`; it pairs any `onRefreshChange(true)` with a `false`. */
  private resetAuthState() {
    this.notifyRefreshChange(false);
    this.setAuthState({ state: "noAuth" });
  }

  private setAuthState(next: AuthState) {
    this.logVerbose(
      `setting auth state to ${JSON.stringify(
        next.state === "waitingForServerConfirmationOfFreshToken"
          ? { hadAuth: next.hadAuth, state: next.state, token: `...${next.token.slice(-7)}` }
          : { state: next.state },
      )}`,
    );
    if (next.state === "waitingForScheduledRefetch" || next.state === "notRefetching" || next.state === "noAuth")
      this.tokenConfirmationAttempts = 0;
    if (this.authState.state === "waitingForScheduledRefetch") clearTimeout(this.authState.refetchTokenTimeoutId);
    this.authState = next;
  }

  private logVerbose(message: string) {
    this.logger.logVerbose(`${message} [v${this.configVersion}]`);
  }
}
