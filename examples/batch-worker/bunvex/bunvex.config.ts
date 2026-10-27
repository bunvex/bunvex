// The app's one component: the batch worker, serving two named workers (`events` in example.ts, `aggregates` in
// aggregates.ts). Convex's example also mounts the rate limiter and static hosting; the rate-limited worker comes
// with `@bunvex/rate-limiter` (STUDY-196 B-2), and `bunvex dev` serves the UI.
import batchWorker from "@bunvex/batch-worker/bunvex.config.js";
import { defineApp } from "bunvex/server";

const app = defineApp();
app.use(batchWorker);

export default app;
