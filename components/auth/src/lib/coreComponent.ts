// The core mounted only as `auth` (STUDY-208 §1.8), v2.0.0's `lib/coreComponent.ts` (`b99e842e`): the core checks each
// access token it signs, so a wrong mount fails the first sign-in with a message. The messages name bunvex's config
// file and cloud URL variable (`BUNVEX_CLOUD_URL`, DV-179) where v2's name Convex's (rule 5).

/**
 * The path the app must mount the core component at: `app.use(auth)` in `bunvex.config.ts`, with no `name` option.
 *
 * ```ts
 * // bunvex/bunvex.config.ts
 * import { defineApp } from "@bunvex/server";
 * import auth from "@bunvex/auth/bunvex.config.js";
 *
 * const app = defineApp();
 * app.use(auth);
 * export default app;
 * ```
 *
 * The app's `auth.config.ts` accepts the core's access tokens only from this path.
 */
export const CORE_COMPONENT_PATH = "auth";

/**
 * Throw when the issuer of a token the core signed shows the core mounted at a path other than
 * {@link CORE_COMPONENT_PATH}. The core runs it on each access token it signs, so a wrong mount fails the first sign-in.
 * A token the deployment signed for the app itself (an issuer with no component path) passes: that happens only in
 * tests that run the core as the app.
 */
export function assertMountedAsCore(token: string): void {
  const componentPath = componentPathFromIssuer(issuerOf(token));
  if (componentPath !== null && componentPath !== CORE_COMPONENT_PATH)
    throw new Error(
      `The auth component is mounted at "${componentPath}", but it must be mounted at "${CORE_COMPONENT_PATH}". ` +
        "Use `app.use(auth)` in bunvex.config.ts, without a `name` option.",
    );
}

/**
 * The component path in the issuer of a token the deployment signed, e.g. `"authPassword"` from
 * `https://x.example/components/authPassword`; null for an issuer that is no component of this deployment (the
 * deployment itself, another deployment, or none).
 */
export function componentPathFromIssuer(issuer: unknown): string | null {
  if (typeof issuer !== "string") return null;
  const prefix = `${cloudUrl()}/components/`;
  if (!issuer.startsWith(prefix)) return null;
  const path = issuer.slice(prefix.length);
  return path === "" ? null : path;
}

/** The deployment's cloud URL, without a trailing slash, as the function reads it. */
function cloudUrl(): string {
  const url = process.env.BUNVEX_CLOUD_URL;
  if (url === undefined || url === "")
    throw new Error(
      "The BUNVEX_CLOUD_URL environment variable is not set. The auth component needs it to check the issuer of a token.",
    );
  return url.replace(/\/+$/, "");
}

/** A JWT's `iss` claim, read without a check of its signature. */
function issuerOf(token: string): unknown {
  const payload = (token.split(".")[1] ?? "").replaceAll("-", "+").replaceAll("_", "/");
  return (JSON.parse(atob(payload.padEnd(Math.ceil(payload.length / 4) * 4, "="))) as { iss?: unknown }).iss;
}
