// The component's definition (STUDY-200 §1.2): named `resend`, with Convex's three children: the rate limiter that
// spaces the batch calls (bunvex's, DV-581), and two pools, one for the batch calls and one for the app's
// `onEmailEvent` callbacks.
import rateLimiter from "@bunvex/rate-limiter/bunvex.config.js";
import { defineComponent } from "@bunvex/server";
import workpool from "@bunvex/workpool/bunvex.config.js";

const component = defineComponent("resend");
component.use(rateLimiter);
component.use(workpool, { name: "emailWorkpool" });
component.use(workpool, { name: "callbackWorkpool" });

export default component;
