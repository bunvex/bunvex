// An app that installs the batch worker as a user's app does: by the package's name and its `./bunvex.config.js`
// export (resolved under the `"bunvex"` condition).
import batchWorker from "@bunvex/batch-worker/bunvex.config.js";
import { defineApp } from "@bunvex/server";

const app = defineApp();
app.use(batchWorker);
export default app;
