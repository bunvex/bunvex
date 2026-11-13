// The auth components this app's sign-ins need: the core (accounts and sessions), the passwords and the usernames.
import auth from "@bunvex/auth/bunvex.config.js";
import authPassword from "@bunvex/auth/components/password/bunvex.config.js";
import authUsername from "@bunvex/auth/components/username/bunvex.config.js";
import { defineApp } from "@bunvex/server";

const app = defineApp();
app.use(auth);
app.use(authPassword);
app.use(authUsername);
export default app;
