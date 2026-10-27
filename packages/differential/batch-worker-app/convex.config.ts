// The app of test/batch-worker.test.ts (STUDY-196): `@convex-dev/batch-worker` 0.3.6 on Convex's backend; the
// harness points bunvex's copy at `@bunvex/batch-worker` (`bunvex.config.ts`).
import batchWorker from "@convex-dev/batch-worker/convex.config";
import { defineApp } from "convex/server";

const app = defineApp();
app.use(batchWorker);
export default app;
