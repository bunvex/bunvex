// An app that mounts the core under another name than `auth` (STUDY-208 §1.8): its first sign-in must fail with the
// core's mount message, and leave nothing behind.
import { defineApp } from "@bunvex/server";
import auth from "../../../../src/component/bunvex.config.ts";
import authPassword from "../../../../src/components/password/bunvex.config.ts";
import authUsername from "../../../../src/components/username/bunvex.config.ts";

const app = defineApp();
app.use(auth, { name: "myAuth" });
app.use(authPassword);
app.use(authUsername);
export default app;
