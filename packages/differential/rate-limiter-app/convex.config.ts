// The app of test/rate-limiter.test.ts (STUDY-197): `@convex-dev/rate-limiter` 0.4.2 on Convex's backend; the
// harness points bunvex's copy at `@bunvex/rate-limiter` (`bunvex.config.ts`).
import rateLimiter from "@convex-dev/rate-limiter/convex.config";
import { defineApp } from "convex/server";

const app = defineApp();
app.use(rateLimiter);
export default app;
