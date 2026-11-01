// The app the component's functions are pushed as: it mounts the batch worker as the component's definition does
// (with `LOG_LEVEL` bound to `REPORT`), so `components.batchWorker` is there for the loop.
import batchWorker from "@bunvex/batch-worker/bunvex.config.js";
import { defineApp } from "@bunvex/server";

const app = defineApp();
app.use(batchWorker, { env: { LOG_LEVEL: "REPORT" } });
export default app;
