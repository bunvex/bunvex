// The app of test/auth.test.ts (STUDY-201 4d): Convex Auth v2 at the pin (`@convex-dev/auth`, built from the reference
// clone, `harness/convex-auth.ts`) on Convex's backend; the test points bunvex's copy at `@bunvex/auth`. The core and
// the three method components, mounted as v2's examples mount them.

import authAnonymous from "@convex-dev/auth/components/anonymous/convex.config.js";
import authPassword from "@convex-dev/auth/components/password/convex.config.js";
import authUsername from "@convex-dev/auth/components/username/convex.config.js";
import auth from "@convex-dev/auth/convex.config.js";
import { defineApp } from "convex/server";

const app = defineApp();
app.use(auth);
app.use(authPassword);
app.use(authUsername);
app.use(authAnonymous);
export default app;
