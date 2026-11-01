// The app the component's functions are pushed as (as upstream's tests run them, `convexTest(schema, modules)` over
// the component's own directory): it mounts the component's three children as its definition does, so
// `components.rateLimiter`, `components.emailWorkpool` and `components.callbackWorkpool` are there for `lib`.
import rateLimiter from "@bunvex/rate-limiter/bunvex.config.js";
import { defineApp } from "@bunvex/server";
import workpool from "@bunvex/workpool/bunvex.config.js";

const app = defineApp();
app.use(rateLimiter);
app.use(workpool, { name: "emailWorkpool" });
app.use(workpool, { name: "callbackWorkpool" });
export default app;
