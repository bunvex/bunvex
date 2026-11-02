// `@bunvex/auth/test` (STUDY-201 C-6), v2's `testing/core.ts`: mount the core component in an app's `@bunvex/testing`
// deployment, and call as a signed-in session. v2's `registerCore(t, name)` registers the component's modules with
// Vite's `import.meta.glob`; here the component registers by its directory, as bunvex's other components do.
import { fileURLToPath } from "node:url";
import type { ComponentApi } from "./component/_generated/component.ts";
import schema from "./component/schema.ts";

/** What `registerCore` needs of a test deployment: `@bunvex/testing`'s `TestBunvex` has it. */
type TestDeployment = { registerComponent(name: string, definition: string): unknown };

/** The core component's directory: its `bunvex.config.ts`, schema and functions. */
const COMPONENT_DIR = fileURLToPath(new URL("./component", import.meta.url));

/**
 * Mount the core auth component in the test deployment `t` (from `bunvexTest()`), before its first call.
 *
 * @param name The name the app mounts it under in its `bunvex.config.ts` (`auth` by default).
 * @returns The component's functions, to call with `t.mutation(…)` / `t.query(…)`.
 */
export function registerCore(t: TestDeployment, name = "auth"): ComponentApi {
  return t.registerComponent(name, COMPONENT_DIR) as ComponentApi;
}

/**
 * The identity the deployment derives from a sign-in's access token, for `t.withIdentity`: its subject is the session,
 * and the core finds the user through it, so a test signs in for real and calls as that session.
 *
 * ```ts
 * const { tokens } = await t.mutation(api.auth.signInAnonymously, {});
 * const alice = t.withIdentity(sessionIdentity(tokens));
 * ```
 */
export function sessionIdentity(tokens: { accessToken: string }): { subject: string } {
  const payload = tokens.accessToken.split(".")[1];
  let sub: unknown;
  try {
    sub = (JSON.parse(Buffer.from(payload ?? "", "base64url").toString("utf8")) as { sub?: unknown }).sub;
  } catch {
    sub = undefined;
  }
  if (typeof sub !== "string") throw new Error("The access token has no subject.");
  return { subject: sub };
}

export default { registerCore, sessionIdentity, schema };
