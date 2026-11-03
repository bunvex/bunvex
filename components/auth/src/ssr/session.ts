// A session on the app's server (STUDY-202 §1.3), v2's `ssr/session.ts`: the cookies of one request, refreshed when the
// access token is missing or about to expire, rewritten with the rotated tokens, cleared when the session is gone. It
// takes the refresh as a function, so it knows no backend client and no framework: a binding supplies both.
import type { RefreshResult, TokenBundle } from "../lib/types.ts";
import {
  AUTH_JWT_COOKIE,
  AUTH_REFRESH_COOKIE,
  type AuthCookieOptions,
  type CookieStore,
  clearAuthCookies,
  writeAuthCookies,
} from "./cookies.ts";
import { isTokenExpiring } from "./jwt.ts";

/** Exchange a refresh token for a new session (over an HTTP client, usually), or learn there is none. */
export type RefreshSession = (refreshToken: string) => Promise<RefreshResult>;

/** What a {@link ServerAuthSession} works with. */
export interface ServerAuthSessionConfig {
  /** The exchange of the cookie's refresh token. */
  refreshSession: RefreshSession;
  /** This request's cookies, and its response's. */
  cookies: CookieStore;
  /** How many seconds before its expiry {@link ServerAuthSession.getToken} replaces an access token (10 by default). */
  refreshSkewSeconds?: number;
  /** The session cookies' attributes. */
  cookieOptions: AuthCookieOptions;
}

/** The session of one request on the app's server, kept in its cookies. */
export class ServerAuthSession {
  readonly #refreshSession: RefreshSession;
  readonly #cookies: CookieStore;
  readonly #refreshSkewSeconds: number;
  readonly #cookieOptions: AuthCookieOptions;

  constructor(config: ServerAuthSessionConfig) {
    this.#refreshSession = config.refreshSession;
    this.#cookies = config.cookies;
    this.#refreshSkewSeconds = config.refreshSkewSeconds ?? 10;
    this.#cookieOptions = config.cookieOptions;
  }

  /**
   * The access token to call the deployment with: the cookie's while it is not about to expire, else a refreshed one
   * (rewriting both cookies). `null` when there is no session.
   */
  async getToken(): Promise<string | null> {
    const token = (await this.#cookies.get(AUTH_JWT_COOKIE)) ?? null;
    if (token !== null && !isTokenExpiring(token, this.#refreshSkewSeconds)) return token;
    const result = await this.refresh();
    return result.kind === "rotated" ? result.tokens.accessToken : null;
  }

  /**
   * Refresh from the refresh-token cookie now: new tokens rewrite both cookies; no session clears them. Without a
   * refresh cookie it is no session, and nothing is called. A failing exchange throws and leaves the cookies as they were.
   */
  async refresh(): Promise<RefreshResult> {
    const refreshToken = (await this.#cookies.get(AUTH_REFRESH_COOKIE)) ?? null;
    if (refreshToken === null) return { kind: "noSession" };
    const result = await this.#refreshSession(refreshToken);
    if (result.kind === "rotated") await this.setTokens(result.tokens);
    else await clearAuthCookies(this.#cookies, this.#cookieOptions);
    return result;
  }

  /** Keep a session's tokens in the cookies (a sign-in's, made elsewhere). */
  async setTokens(bundle: TokenBundle): Promise<void> {
    await writeAuthCookies(this.#cookies, bundle, this.#cookieOptions);
  }
}
