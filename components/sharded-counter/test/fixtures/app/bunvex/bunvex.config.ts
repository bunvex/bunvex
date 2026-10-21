// An app that installs the sharded counter as a user's app does: by the package's name and its
// `./bunvex.config.js` export (resolved under the `"bunvex"` condition), mounted twice.
import { defineApp } from "@bunvex/server";
import shardedCounter from "@bunvex/sharded-counter/bunvex.config.js";

const app = defineApp();
app.use(shardedCounter);
app.use(shardedCounter, { name: "otherCounter" });
export default app;
