// `@bunvex/sharded-counter/test` (STUDY-183 §3.1): mount the component in an app's `@bunvex/testing` deployment, as
// Convex's package's `register(t, name)` does for convex-test. bunvex's harness pushes the component's own directory
// (`registerComponent(name, dir)`), so it needs no list of modules.
import { fileURLToPath } from "node:url";
import type { ComponentApi } from "./component/_generated/component.ts";
import schema from "./component/schema.ts";

/** What `register` needs of a test deployment: `@bunvex/testing`'s `TestBunvex` has it. */
type TestDeployment = { registerComponent(name: string, definition: string): unknown };

/** The component's directory: its `bunvex.config.ts`, schema and functions. */
const COMPONENT_DIR = fileURLToPath(new URL("./component", import.meta.url));

/**
 * Mount the sharded counter in the test deployment `t` (from `bunvexTest()`), before its first call.
 *
 * @param name The name the app mounts it under in its `bunvex.config.ts` (`shardedCounter` by default).
 * @returns The component's functions, to call with `t.mutation(…)` / `t.query(…)` or to give a `ShardedCounter`.
 */
export function register(t: TestDeployment, name = "shardedCounter"): ComponentApi {
  return t.registerComponent(name, COMPONENT_DIR) as ComponentApi;
}

export default { register, schema };
