// The app's component: `kv`, with a schema of its own, which the test deploys without too.
import { defineApp } from "convex/server";
import kv from "./kv/convex.config";

const app = defineApp();
app.use(kv);
export default app;
