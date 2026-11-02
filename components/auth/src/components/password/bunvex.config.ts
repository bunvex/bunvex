// The password component (STUDY-201 §1.6): named `authPassword`, as v2's. It stores and checks passwords keyed by an
// opaque user id, and knows nothing of who the user is (the app maps its identifiers onto the id). It mounts the rate
// limiter, as `rateLimiter`, to throttle checks per user: bunvex's, 0.4.2's shape (DV-581).
import rateLimiter from "@bunvex/rate-limiter/bunvex.config.js";
import { defineComponent } from "@bunvex/server";

const component = defineComponent("authPassword");
component.use(rateLimiter);

export default component;
