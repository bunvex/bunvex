// The auth components this app's sign-ins need: the core (accounts and sessions), the passwords and the usernames, and
// the anonymous accounts.
import auth from "@bunvex/auth/bunvex.config.js";
import authAnonymous from "@bunvex/auth/components/anonymous/bunvex.config.js";
import authPassword from "@bunvex/auth/components/password/bunvex.config.js";
import authUsername from "@bunvex/auth/components/username/bunvex.config.js";
import { defineApp } from "@bunvex/server";

const app = defineApp();
app.use(auth);
app.use(authPassword);
app.use(authUsername);
app.use(authAnonymous);
export default app;
