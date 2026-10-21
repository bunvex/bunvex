// The app's components: `thrower`, whose functions throw.
import { defineApp } from "convex/server";
import thrower from "./thrower/convex.config";

const app = defineApp();
app.use(thrower);
export default app;
