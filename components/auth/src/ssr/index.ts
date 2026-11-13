// `@bunvex/auth/ssr` (STUDY-202 §1.1), v2's `./ssr`: the session under server rendering, for any framework that speaks
// WHATWG `Request`/`Response`: the refresh token in an httpOnly cookie, never in the page; the refresh, sign-out and
// sign-in routes; the cookie and token helpers they are built from; the server-side session check.

export type {
  AuthApi,
  AuthSessionResponse,
  ClientView,
  IsAuthenticatedFn,
  RefreshResult,
  RefreshSessionFn,
  SignInComplete,
  SignInEnvelope,
  SignInError,
  SignInStatus,
  SignOutFn,
  SlimTokenBundle,
  TokenBundle,
} from "../lib/types.ts";
export { makeSlimBundle } from "../lib/types.ts";
export {
  AUTH_JWT_COOKIE,
  AUTH_REFRESH_COOKIE,
  type AuthCookieOptions,
  type CookieDeleteOptions,
  type CookieOptions,
  type CookieStore,
  clearAuthCookies,
  writeAuthCookies,
} from "./cookies.ts";
export {
  type RefreshHandlerConfig,
  type RequestHandler,
  refreshHandler,
  type SignOutHandlerConfig,
  signOutHandler,
} from "./handlers.ts";
export { type HttpCookies, httpCookies, serializeCookie } from "./httpCookies.ts";
export {
  createServerAuthChecker,
  type ServerAuthChecker,
  type ServerAuthCheckerConfig,
} from "./isAuthenticated.ts";
export { type DecodedAccessToken, decodeAccessToken, isTokenExpiring } from "./jwt.ts";
export { isTrustedOrigin } from "./origin.ts";
export { type RefreshSession, ServerAuthSession, type ServerAuthSessionConfig } from "./session.ts";
export { type BunvexAuthServerConfig, setupBunvexAuthServer } from "./setup.ts";
export { type BunvexProxyConfig, bunvexProxyHandler, type ExposedSignInFn } from "./signInProxy.ts";
