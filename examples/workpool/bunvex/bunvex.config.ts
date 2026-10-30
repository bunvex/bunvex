// The app's three pools: one component, mounted once per pool, each with its own tables and its own limit on how
// many jobs run at once.
import { defineApp } from "@bunvex/server";
import workpool from "@bunvex/workpool/bunvex.config.js";

const app = defineApp();
app.use(workpool, { name: "bigPool" });
app.use(workpool, { name: "smallPool" });
app.use(workpool, { name: "serialPool" });

export default app;
