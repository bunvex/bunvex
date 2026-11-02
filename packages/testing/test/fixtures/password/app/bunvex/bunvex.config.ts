import { defineApp } from "@bunvex/server";
import authPassword from "../../auth-password/bunvex.config";
import other from "../../other/bunvex.config";

const app = defineApp();
app.use(authPassword);
app.use(other);
export default app;
