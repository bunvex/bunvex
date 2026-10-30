// `@bunvex/resend/test` (STUDY-200 §1.10, STUDY-183 §3.1): mount the component in an app's `@bunvex/testing`
// deployment, as Convex's package's `register(t, name)` does for its test harness. Convex's registers the children
// (`<name>/rateLimiter`, `<name>/emailWorkpool`, `<name>/callbackWorkpool`) itself; here they come with the
// component's definition.
import { fileURLToPath } from "node:url";
import type { ComponentApi } from "./component/_generated/component.ts";
import schema from "./component/schema.ts";

/** What `register` needs of a test deployment: `@bunvex/testing`'s `TestBunvex` has it. */
type TestDeployment = { registerComponent(name: string, definition: string): unknown };

/** The component's directory: its `bunvex.config.ts` (which mounts its children), schema and functions. */
const COMPONENT_DIR = fileURLToPath(new URL("./component", import.meta.url));

/**
 * Mount the component in the test deployment `t` (from `bunvexTest()`), before its first call. Its children, the rate
 * limiter and the two pools, come with it.
 *
 * @param name The name the app mounts it under in its `bunvex.config.ts` (`resend` by default).
 * @returns The component's functions, to call with `t.mutation(…)` / `t.query(…)` or to give a `Resend`.
 */
export function register(t: TestDeployment, name = "resend"): ComponentApi {
  return t.registerComponent(name, COMPONENT_DIR) as ComponentApi;
}

export default { register, schema };
