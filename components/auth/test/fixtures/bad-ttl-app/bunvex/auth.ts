// An inactivity timeout longer than the max lifetime: `setupAuth` refuses it as the module loads.
import { componentsGeneric } from "@bunvex/server";
import type { ComponentApi } from "../../../../src/component/_generated/component.ts";
import { setupAuth } from "../../../../src/server/setup.ts";

const components = componentsGeneric() as unknown as { auth: ComponentApi };

const auth = setupAuth({
  component: components.auth,
  refreshInactivityTimeoutSeconds: 2 * 60 * 60,
  sessionMaxLifetimeSeconds: 60 * 60,
});
export const { signOut, refreshSession, isAuthenticated } = auth;
