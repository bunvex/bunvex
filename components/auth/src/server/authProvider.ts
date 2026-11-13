// `bunvexAuthProvider` (STUDY-201 §1.10, STUDY-208 §1.8), v2.0.0's `convexAuthProvider` in bunvex's words (rule 5):
// the provider the app lists in its `auth.config.ts` to accept the core's access tokens, as any custom JWT (no
// shortcut): the issuer is the core's path under the deployment (`auth`, the only mount the core accepts), the keys
// the deployment's JWKS, the audience `bunvex-auth` (DV-576; v2's is `convex-auth`). It takes no options, as v2's
// (`componentName` is gone, `b99e842e`). The cloud URL is `BUNVEX_CLOUD_URL` (DV-179).
import type { AuthProvider } from "@bunvex/server";
import { CORE_COMPONENT_PATH } from "../lib/coreComponent.ts";

/**
 * The provider your `bunvex/auth.config.ts` lists to accept the auth component's access tokens: they are signed with
 * your deployment's key, issued by the component's path under your deployment, and verified against its public keys.
 *
 * ```ts
 * // bunvex/auth.config.ts
 * import type { AuthConfig } from "@bunvex/server";
 * import { bunvexAuthProvider } from "@bunvex/auth/server";
 *
 * export default { providers: [bunvexAuthProvider()] } satisfies AuthConfig;
 * ```
 *
 * Your app mounts the auth component as `auth` (`app.use(auth)` in `bunvex.config.ts`), its default name.
 */
export function bunvexAuthProvider(): AuthProvider {
  const cloudUrl = process.env.BUNVEX_CLOUD_URL;
  if (!cloudUrl) throw new Error("bunvexAuthProvider: the BUNVEX_CLOUD_URL environment variable is not set");
  return {
    type: "customJwt",
    // The `aud` the auth component gives its tokens.
    applicationID: "bunvex-auth",
    issuer: `${cloudUrl}/components/${CORE_COMPONENT_PATH}`,
    jwks: `${cloudUrl}/.well-known/jwks.json`,
    algorithm: "ES256",
  };
}
