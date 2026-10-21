// The app of test/sharded-counter.test.ts (STUDY-183): `@convex-dev/sharded-counter` 0.2.3 mounted twice on Convex's
// backend; the harness points bunvex's copy at `@bunvex/sharded-counter` (`bunvex.config.ts`).
import shardedCounter from "@convex-dev/sharded-counter/convex.config";
import { defineApp } from "convex/server";

const app = defineApp();
app.use(shardedCounter);
app.use(shardedCounter, { name: "second" });
export default app;
