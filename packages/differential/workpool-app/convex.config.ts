// The app of test/workpool.test.ts (STUDY-199): `@convex-dev/workpool` 0.4.14 on Convex's backend; the harness points
// bunvex's copy at `@bunvex/workpool` (`bunvex.config.ts`).
import workpool from "@convex-dev/workpool/convex.config";
import { defineApp } from "convex/server";

const app = defineApp();
app.use(workpool, { name: "pool" });
export default app;
