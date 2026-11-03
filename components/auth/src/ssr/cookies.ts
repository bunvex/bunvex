// The session's cookies under server rendering (STUDY-202 §1.2), v2's `ssr/cookies.ts` in bunvex's words: the refresh
// token and the access token each in an httpOnly, SameSite=Lax cookie named as the browser's storage keys (DV-577), so
// the page's JavaScript never holds the refresh token. Both live as long as the refresh token: an expired access token
// in its cookie is what tells the host to refresh.
import { JWT_STORAGE_KEY, REFRESH_TOKEN_STORAGE_KEY } from "../lib/storageKeys.ts";
import type { TokenBundle } from "../lib/types.ts";

/** The name of the cookie that holds the access token (a JWT). */
export const AUTH_JWT_COOKIE = JWT_STORAGE_KEY;
/** The name of the httpOnly cookie that holds the refresh token. */
export const AUTH_REFRESH_COOKIE = REFRESH_TOKEN_STORAGE_KEY;

/** A cookie's attributes. */
export interface CookieOptions {
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "lax" | "strict" | "none";
  path?: string;
  maxAge?: number;
  expires?: Date;
  domain?: string;
}

/** The attributes a deletion must repeat to reach the cookie it deletes. */
export type CookieDeleteOptions = Pick<CookieOptions, "path" | "domain">;

/**
 * The attributes an app chooses for the session's cookies: where they apply, and `secure`, which it must decide (HTTPS
 * only in production, plain http on a local dev server). The rest is fixed: httpOnly, SameSite=Lax, and an expiry at the
 * refresh token's.
 */
export type AuthCookieOptions = CookieDeleteOptions & { secure: boolean };

/** The cookies of one request and its response, as a framework exposes them; each method may be async. */
export interface CookieStore {
  get: (name: string) => string | undefined | Promise<string | undefined>;
  set: (name: string, value: string, options?: CookieOptions) => void | Promise<void>;
  delete: (name: string, options?: CookieDeleteOptions) => void | Promise<void>;
}

// Each field taken by name, so an object wider than its type (from JavaScript) cannot turn httpOnly off.
function sessionCookieOptions(refreshTokenExpiresAt: number, options: AuthCookieOptions): CookieOptions {
  return {
    httpOnly: true,
    sameSite: "lax",
    path: options.path ?? "/",
    domain: options.domain,
    secure: options.secure,
    expires: new Date(refreshTokenExpiresAt),
  };
}

/** Write a session's tokens into their cookies: the access token's, then the refresh token's. */
export async function writeAuthCookies(
  cookies: CookieStore,
  bundle: TokenBundle,
  options: AuthCookieOptions,
): Promise<void> {
  const attributes = sessionCookieOptions(bundle.refreshTokenExpiresAt, options);
  await cookies.set(AUTH_JWT_COOKIE, bundle.accessToken, attributes);
  await cookies.set(AUTH_REFRESH_COOKIE, bundle.refreshToken, attributes);
}

/** Delete both session cookies, with the `path` (`/` by default, as written) and `domain` they were written with. */
export async function clearAuthCookies(cookies: CookieStore, options: AuthCookieOptions): Promise<void> {
  const { path = "/", domain } = options;
  await cookies.delete(AUTH_JWT_COOKIE, { path, domain });
  await cookies.delete(AUTH_REFRESH_COOKIE, { path, domain });
}
