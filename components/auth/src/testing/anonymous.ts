// The anonymous component's test helper (STUDY-201 C-6), v2's `testing/anonymous.ts`, no longer exported (STUDY-208 D-3): mount the `authAnonymous` component in an app's
// `@bunvex/testing` deployment. v2 registers its modules with Vite's `import.meta.glob`; here it registers by its directory.
import { fileURLToPath } from "node:url";
import type { ComponentApi } from "../components/anonymous/_generated/component.ts";
import schema from "../components/anonymous/schema.ts";

/** What `registerAnonymous` needs of a test deployment: `@bunvex/testing`'s `TestBunvex` has it. */
type TestDeployment = { registerComponent(name: string, definition: string): unknown };

const COMPONENT_DIR = fileURLToPath(new URL("../components/anonymous", import.meta.url));

/**
 * Mount the `authAnonymous` component in the test deployment `t` (from `bunvexTest()`), before its first call.
 *
 * @param name The name the app mounts it under in its `bunvex.config.ts` (`authAnonymous` by default).
 * @returns The component's functions, to call with `t.mutation(…)` / `t.query(…)`.
 *
 * @internal Not public until the anonymous sign-in method is ready.
 */
export function registerAnonymous(t: TestDeployment, name = "authAnonymous"): ComponentApi {
  return t.registerComponent(name, COMPONENT_DIR) as ComponentApi;
}

export default { registerAnonymous, schema };
