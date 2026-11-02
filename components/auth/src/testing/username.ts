// `@bunvex/auth/components/username/test` (STUDY-201 C-6), v2's `testing/username.ts`: mount the `authUsername` component in an app's
// `@bunvex/testing` deployment. v2 registers its modules with Vite's `import.meta.glob`; here it registers by its directory.
import { fileURLToPath } from "node:url";
import type { ComponentApi } from "../components/username/_generated/component.ts";
import schema from "../components/username/schema.ts";

/** What `registerUsername` needs of a test deployment: `@bunvex/testing`'s `TestBunvex` has it. */
type TestDeployment = { registerComponent(name: string, definition: string): unknown };

const COMPONENT_DIR = fileURLToPath(new URL("../components/username", import.meta.url));

/**
 * Mount the `authUsername` component in the test deployment `t` (from `bunvexTest()`), before its first call.
 *
 * @param name The name the app mounts it under in its `bunvex.config.ts` (`authUsername` by default).
 * @returns The component's functions, to call with `t.mutation(…)` / `t.query(…)`.
 */
export function registerUsername(t: TestDeployment, name = "authUsername"): ComponentApi {
  return t.registerComponent(name, COMPONENT_DIR) as ComponentApi;
}

export default { registerUsername, schema };
