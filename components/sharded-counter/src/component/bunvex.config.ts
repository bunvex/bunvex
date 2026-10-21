// The sharded counter's definition (STUDY-183): the component is named `shardedCounter`, as Convex's
// `@convex-dev/sharded-counter`, so an app's `components.shardedCounter` and the dashboard see the same name.
import { defineComponent } from "@bunvex/server";

export default defineComponent("shardedCounter");
