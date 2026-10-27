// The app the component's functions are pushed as: it mounts the batch worker, as the component's definition does,
// so the asynchronous mode's `components.batchWorker` is there.
import batchWorker from "@bunvex/batch-worker/bunvex.config.js";
import { defineApp } from "@bunvex/server";

const app = defineApp();
app.use(batchWorker);
export default app;
