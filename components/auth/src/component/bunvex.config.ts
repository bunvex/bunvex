// The core auth component (STUDY-201 §1.2, STUDY-208 §1.8): named `auth`, as Convex Auth v2's, and mounted only under
// that name. It keeps sessions with their rotating refresh tokens; the mapping of a method's identity to the app's user
// lives in that method's component. It knows no sign-in method and holds no signing key (the deployment signs its
// access tokens, `ctx.auth.signJwt`).
import { defineComponent } from "@bunvex/server";

const component = defineComponent("auth");

export default component;
