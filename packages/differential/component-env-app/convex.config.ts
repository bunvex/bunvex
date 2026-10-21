// The app's components: `envc` mounted twice, once with its variables bound (a value, and the app's `APPKEY`), once
// with none.
import { defineApp } from "convex/server";
import { v } from "convex/values";
import envc from "./envc/convex.config";

const app = defineApp({ env: { APPKEY: v.optional(v.string()) } });
app.use(envc, { env: { MODE: "fast", KEY: app.env.APPKEY } });
app.use(envc, { name: "second" });
export default app;
