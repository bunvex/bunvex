// `@bunvex/batch-worker/test` (STUDY-196 §1.7, STUDY-183 §3.1): mount the batch worker in an app's
// `@bunvex/testing` deployment, as Convex's package's `register(t, name)` does for convex-test.
import { fileURLToPath } from "node:url";
import type { ComponentApi } from "./component/_generated/component.ts";
import schema from "./component/schema.ts";

/** What `register` needs of a test deployment: `@bunvex/testing`'s `TestBunvex` has it. */
type TestDeployment = { registerComponent(name: string, definition: string): unknown };

/** The component's directory: its `bunvex.config.ts`, schema and functions. */
const COMPONENT_DIR = fileURLToPath(new URL("./component", import.meta.url));

/**
 * Mount the batch worker in the test deployment `t` (from `bunvexTest()`), before its first call.
 *
 * @param name The name the app mounts it under in its `bunvex.config.ts` (`batchWorker` by default).
 * @returns The component's functions, to call with `t.mutation(…)` / `t.query(…)` or to give `ping`.
 */
export function register(t: TestDeployment, name = "batchWorker"): ComponentApi {
  return t.registerComponent(name, COMPONENT_DIR) as ComponentApi;
}

export default { register, schema };
