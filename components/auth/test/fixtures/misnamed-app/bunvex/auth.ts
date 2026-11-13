// The username + password method over the core mounted as `myAuth`.
import { componentsGeneric, makeFunctionReference } from "@bunvex/server";
import type { ComponentApi } from "../../../../src/component/_generated/component.ts";
import type { ComponentApi as PasswordApi } from "../../../../src/components/password/_generated/component.ts";
import type { ComponentApi as UsernameApi } from "../../../../src/components/username/_generated/component.ts";
import { setupUsernamePassword } from "../../../../src/methods/username-password/server.ts";
import { setupAuth } from "../../../../src/server/setup.ts";

const components = componentsGeneric() as unknown as {
  myAuth: ComponentApi;
  authPassword: PasswordApi;
  authUsername: UsernameApi;
};
// biome-ignore lint/suspicious/noExplicitAny: the app's internal reference, as its codegen would type it
const createUser = makeFunctionReference<"mutation">("users:createUser") as any;

const auth = setupAuth({ component: components.myAuth });
export const { signOut, refreshSession, isAuthenticated } = auth;

export const { signUpWithUsernamePassword } = setupUsernamePassword(auth, {
  component: components.authPassword,
  usernameComponent: components.authUsername,
}).attachUserCallbacks({ createUser });
