// The core auth component (STUDY-201 §1.2): named `auth`, as Convex Auth v2's. It maps each method's identity to the
// app's user (`accounts`) and keeps sessions with their rotating refresh tokens; it knows no sign-in method and holds no
// signing key (the deployment signs its access tokens, `ctx.auth.signJwt`).
import { defineComponent } from "@bunvex/server";

const component = defineComponent("auth");

export default component;
