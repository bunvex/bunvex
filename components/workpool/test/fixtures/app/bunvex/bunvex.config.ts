// An app that installs the pool as a user's app does: by the package's name and its `./bunvex.config.js` export. The
// batch worker comes with it, as its child.

import { defineApp } from "@bunvex/server";
import workpool from "@bunvex/workpool/bunvex.config.js";

const app = defineApp();
app.use(workpool);
export default app;
