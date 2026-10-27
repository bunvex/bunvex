// The app's component: `pager`, whose query paginates its own table.
import { defineApp } from "convex/server";
import pager from "./pager/convex.config";

const app = defineApp();
app.use(pager);
export default app;
