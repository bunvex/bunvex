// The app of test/component-ids.test.ts: one local component, `child`.
import { defineApp } from "convex/server";
import child from "./child/convex.config";

const app = defineApp();
app.use(child);
export default app;
