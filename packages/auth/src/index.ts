// Package @bunvex/auth — identity for bunvex functions (STUDY-27): the auth config, JWT / OIDC verification,
// and the `UserIdentity` a function's `ctx.auth.getUserIdentity()` returns.
export {
  AUTH_CONFIG_FILE,
  type AuthConfig,
  type AuthInfo,
  type AuthProvider,
  normalizeIssuerUrl,
  parseAuthConfig,
} from "./config.ts";
export { AuthenticationError } from "./errors.ts";
export { identityFromCustomJwt, identityFromOidc, type UserIdentity, type VerifiedIdentity } from "./identity.ts";
export { TokenVerifier, type VerifierOptions } from "./verify.ts";
