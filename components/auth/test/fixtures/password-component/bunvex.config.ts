// The `authPassword` component as the suite mounts it: its real functions and schema, and `testing`'s, which read and
// write its rows (upstream's suite runs the component as the root app and reads them with `t.run`). It is a component
// named `authPassword`, so the runtime's password hasher answers its mutations (AD-49), as it would the real one's.
import rateLimiter from "@bunvex/rate-limiter/bunvex.config.js";
import { defineComponent } from "@bunvex/server";

const component = defineComponent("authPassword");
component.use(rateLimiter);

export default component;
