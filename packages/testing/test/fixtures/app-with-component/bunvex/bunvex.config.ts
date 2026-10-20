import { defineApp } from "@bunvex/server";
import counter from "../../counter/bunvex.config";

const app = defineApp();
app.use(counter);
export default app;
