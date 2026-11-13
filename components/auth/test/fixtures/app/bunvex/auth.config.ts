// The provider that accepts the core's access tokens, as an app lists it: a deployed server checks them with it.
import type { AuthConfig } from "@bunvex/server";
import { bunvexAuthProvider } from "../../../../src/server/authProvider.ts";

export default { providers: [bunvexAuthProvider()] } satisfies AuthConfig;
