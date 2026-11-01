// The app's one component: the email queue, which sends to Resend in batches and records what Resend reports back.

import resend from "@bunvex/resend/bunvex.config.js";
import { defineApp } from "@bunvex/server";

const app = defineApp();
app.use(resend);

export default app;
