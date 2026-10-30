// `@bunvex/workpool/test` (STUDY-199 §1.16, STUDY-183 §3.1): mount the pool (and its child, the batch worker) in an
// app's `@bunvex/testing` deployment, as Convex's package's `register(t, name)` does for convex-test. Convex's
// registers the child under `<name>/batchWorker` itself; here the child comes with the pool's definition.
import { fileURLToPath } from "node:url";
import type { ComponentApi } from "./component/_generated/component.ts";
import schema from "./component/schema.ts";

/** What `register` needs of a test deployment: `@bunvex/testing`'s `TestBunvex` has it. */
type TestDeployment = { registerComponent(name: string, definition: string): unknown };

/** The component's directory: its `bunvex.config.ts` (which mounts the batch worker), schema and functions. */
const COMPONENT_DIR = fileURLToPath(new URL("./component", import.meta.url));

/**
 * Mount the pool in the test deployment `t` (from `bunvexTest()`), before its first call. Its child, the batch worker
 * that runs its loop, comes with it.
 *
 * @param name The name the app mounts it under in its `bunvex.config.ts` (`workpool` by default).
 * @returns The component's functions, to call with `t.mutation(…)` / `t.query(…)` or to give a `Workpool`.
 */
export function register(t: TestDeployment, name = "workpool"): ComponentApi {
  return t.registerComponent(name, COMPONENT_DIR) as ComponentApi;
}

export default { register, schema };
