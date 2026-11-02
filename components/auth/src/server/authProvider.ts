// `bunvexAuthProvider` (STUDY-201 §1.10), v2's `convexAuthProvider` in bunvex's words (rule 5): the provider the app
// lists in its `auth.config.ts` to accept the core's access tokens, as any custom JWT (no shortcut): the issuer is the
// core's path under the deployment, the keys the deployment's JWKS, the audience `bunvex` (DV-576). The cloud URL is
// `BUNVEX_CLOUD_URL` (DV-179).
import type { AuthProvider } from "@bunvex/server";

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
 * @param options.componentName The name your app mounts the auth component under (`app.use(auth, { name })`); `auth`
 * by default.
 */
export function bunvexAuthProvider(options: { componentName?: string } = {}): AuthProvider {
  const componentName = options.componentName ?? "auth";
  const cloudUrl = process.env.BUNVEX_CLOUD_URL;
  if (!cloudUrl) throw new Error("bunvexAuthProvider: the BUNVEX_CLOUD_URL environment variable is not set");
  return {
    type: "customJwt",
    // The `aud` the auth component gives its tokens.
    applicationID: "bunvex",
    issuer: `${cloudUrl}/components/${componentName}`,
    jwks: `${cloudUrl}/.well-known/jwks.json`,
    algorithm: "ES256",
  };
}
