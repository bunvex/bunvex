// The app's components: the batch worker, serving three named workers (`events` in example.ts, `aggregates` in
// aggregates.ts, `llm` in rateLimited.ts), and the rate limiter the `llm` worker spends its token budget from.
// Convex's example also mounts static hosting; `bunvex dev` serves the UI.
import batchWorker from "@bunvex/batch-worker/bunvex.config.js";
import rateLimiter from "@bunvex/rate-limiter/bunvex.config.js";
import { defineApp } from "@bunvex/server";

const app = defineApp();
app.use(batchWorker);
app.use(rateLimiter);

export default app;
