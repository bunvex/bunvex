// The deployment's authentication providers, in the dashboard contract (UI-01 §19.1, STUDY-12 §13.1), as
// Convex's `_system/frontend/listAuthProviders` (the `_auth` table, what `auth.config.ts` declares). The method
// is optional: a source offers the Authentication page by having it (detected with `typeof`). Re-exported by
// `data-source.ts`.
import type { CallOptions } from "./data-source.ts";

/** An OpenID Connect provider (Convex's `{ domain, applicationID }`): tokens from `domain`, for `applicationID`. */
export type OidcAuthProvider = { type?: undefined; domain: string; applicationID: string };

/** A custom JWT provider (Convex's `{ type: "customJwt", ... }`): tokens signed with the keys at `jwks`. */
export type CustomJwtAuthProvider = {
  type: "customJwt";
  issuer: string;
  jwks: string;
  algorithm: "RS256" | "ES256";
  /** Omitting it is often insecure (Convex's warning): any audience is accepted. */
  applicationID?: string;
};

export type AuthProvider = OidcAuthProvider | CustomJwtAuthProvider;

export interface AuthFeatures {
  /**
   * The configured providers, in their declared order; empty when there are none. Needs the `viewData` and
   * `viewEnvironmentVariables` operations (Convex's Authentication page asks for both).
   */
  listAuthProviders?(opts?: CallOptions): Promise<AuthProvider[]>;
}
