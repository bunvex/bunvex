// The provider, as an app lists it (it names the core at `auth`, where this app does not mount it).
import type { AuthConfig } from "@bunvex/server";
import { bunvexAuthProvider } from "../../../../src/server/authProvider.ts";

export default { providers: [bunvexAuthProvider()] } satisfies AuthConfig;
