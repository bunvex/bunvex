// The rate limiter's definition (STUDY-197 §1.1): named `rateLimiter`, as Convex's `@convex-dev/rate-limiter`, with
// the batch worker as its child, for limits applied asynchronously.
import batchWorker from "@bunvex/batch-worker/bunvex.config.js";
import { defineComponent } from "@bunvex/server";

const component = defineComponent("rateLimiter");
component.use(batchWorker);

export default component;
