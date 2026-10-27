// `@bunvex/rate-limiter/test` (STUDY-197 §1.6, STUDY-183 §3.1): mount the rate limiter (and its child, the batch
// worker) in an app's `@bunvex/testing` deployment, as Convex's package's `register(t, name)` does for convex-test.
import { fileURLToPath } from "node:url";
import type { ComponentApi } from "./component/_generated/component.ts";
import schema from "./component/schema.ts";

/** What `register` needs of a test deployment: `@bunvex/testing`'s `TestBunvex` has it. */
type TestDeployment = { registerComponent(name: string, definition: string): unknown };

/** The component's directory: its `bunvex.config.ts` (which mounts the batch worker), schema and functions. */
const COMPONENT_DIR = fileURLToPath(new URL("./component", import.meta.url));

/**
 * Mount the rate limiter in the test deployment `t` (from `bunvexTest()`), before its first call. Its child, the
 * batch worker, comes with it from its definition.
 *
 * @param name The name the app mounts it under in its `bunvex.config.ts` (`rateLimiter` by default).
 */
export function register(t: TestDeployment, name = "rateLimiter"): ComponentApi {
  return t.registerComponent(name, COMPONENT_DIR) as ComponentApi;
}

export default { register, schema };
