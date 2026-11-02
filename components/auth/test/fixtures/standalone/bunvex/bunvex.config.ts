// The core's functions pushed as an app's (as upstream's suite runs them, the component as the root app): `public:*`
// are the app's, and `t.run` reads the core's tables directly. The access tokens' `iss` is then the deployment's bare
// origin, not `…/components/auth`.
import { defineApp } from "@bunvex/server";

export default defineApp();
