// The app's components (Convex only): the `counter` definition mounted twice.
import { defineApp } from "convex/server";
import counter from "./counter/convex.config";

const app = defineApp();
app.use(counter);
app.use(counter, { name: "second" });
export default app;
