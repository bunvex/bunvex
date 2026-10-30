// The app of test/resend.test.ts (STUDY-200): `@convex-dev/resend` 0.2.10 on Convex's backend; the harness points
// bunvex's copy at `@bunvex/resend` (`bunvex.config.ts`).
import resend from "@convex-dev/resend/convex.config";
import { defineApp } from "convex/server";

const app = defineApp();
app.use(resend);
export default app;
