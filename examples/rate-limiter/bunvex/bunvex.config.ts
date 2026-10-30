// The app's one component, the rate limiter. Its limits live in its own tables; the app names them in example.ts
// and playground.ts.
import rateLimiter from "@bunvex/rate-limiter/bunvex.config.js";
import { defineApp } from "@bunvex/server";

const app = defineApp();
app.use(rateLimiter);

export default app;
