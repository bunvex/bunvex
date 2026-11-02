// An app with built-in auth: the core and the three method components, mounted as an app mounts them.
import { defineApp } from "@bunvex/server";
import auth from "../../../../src/component/bunvex.config.ts";
import authAnonymous from "../../../../src/components/anonymous/bunvex.config.ts";
import authPassword from "../../../../src/components/password/bunvex.config.ts";
import authUsername from "../../../../src/components/username/bunvex.config.ts";

const app = defineApp();
app.use(auth);
app.use(authPassword);
app.use(authUsername);
app.use(authAnonymous);
export default app;
