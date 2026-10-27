// The batch worker's definition (STUDY-196 §1.1): named `batchWorker`, as Convex's `@convex-dev/batch-worker`, with
// the one variable it declares, `LOG_LEVEL`, that a parent may bind.
import { defineComponent } from "@bunvex/server";
import { v } from "@bunvex/values";
import { logLevel } from "./logging";

export default defineComponent("batchWorker", {
  env: {
    LOG_LEVEL: v.optional(logLevel),
  },
});
