// The auth components anonymous sign-in needs: the core (accounts and sessions) and the anonymous accounts.
import auth from "@bunvex/auth/bunvex.config.js";
import authAnonymous from "@bunvex/auth/components/anonymous/bunvex.config.js";
import { defineApp } from "@bunvex/server";

const app = defineApp();
app.use(auth);
app.use(authAnonymous);
export default app;
