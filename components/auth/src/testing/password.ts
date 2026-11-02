// `@bunvex/auth/components/password/test` (STUDY-201 C-6), v2's `testing/password.ts`: mount the `authPassword` component in an app's
// `@bunvex/testing` deployment. v2 registers its modules with Vite's `import.meta.glob`; here it registers by its directory.
import { fileURLToPath } from "node:url";
import type { ComponentApi } from "../components/password/_generated/component.ts";
import schema from "../components/password/schema.ts";

/** What `registerPasswordProvider` needs of a test deployment: `@bunvex/testing`'s `TestBunvex` has it. */
type TestDeployment = { registerComponent(name: string, definition: string): unknown };

const COMPONENT_DIR = fileURLToPath(new URL("../components/password", import.meta.url));

/**
 * Mount the `authPassword` component in the test deployment `t` (from `bunvexTest()`), before its first call. Its child, the rate limiter (`<name>/rateLimiter`), comes with its definition.
 *
 * @param name The name the app mounts it under in its `bunvex.config.ts` (`authPassword` by default).
 * @returns The component's functions, to call with `t.mutation(…)` / `t.query(…)`.
 */
export function registerPasswordProvider(t: TestDeployment, name = "authPassword"): ComponentApi {
  return t.registerComponent(name, COMPONENT_DIR) as ComponentApi;
}

export default { registerPasswordProvider, schema };
