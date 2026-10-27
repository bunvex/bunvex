// An app that installs the rate limiter as a user's app does: by the package's name and its `./bunvex.config.js`
// export. The batch worker comes with it, as its child.
import rateLimiter from "@bunvex/rate-limiter/bunvex.config.js";
import { defineApp } from "@bunvex/server";

const app = defineApp();
app.use(rateLimiter);
export default app;
