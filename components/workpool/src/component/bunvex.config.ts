// The pool's definition (STUDY-199 §1.2): named `workpool`, as Convex's workpool, with the batch worker as its child,
// which runs the pool's loop. The child logs at `REPORT`, whatever the pool's own level.
import batchWorker from "@bunvex/batch-worker/bunvex.config.js";
import { defineComponent } from "@bunvex/server";

const component = defineComponent("workpool");
component.use(batchWorker, { env: { LOG_LEVEL: "REPORT" } });

export default component;
