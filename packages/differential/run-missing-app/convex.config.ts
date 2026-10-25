// The app's component: `cmp`, mounted once.
import { defineApp } from "convex/server";
import cmp from "./cmp/convex.config";

const app = defineApp();
app.use(cmp);
export default app;
