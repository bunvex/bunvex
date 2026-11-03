// The auth component's access tokens, accepted like any custom JWT: signed with this deployment's key.
import { bunvexAuthProvider } from "@bunvex/auth/server";
import type { AuthConfig } from "@bunvex/server";

export default { providers: [bunvexAuthProvider()] } satisfies AuthConfig;
