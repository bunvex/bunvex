// The app's auth, as an app wires it (STUDY-201 §1.13).
import { componentsGeneric, makeFunctionReference, query } from "@bunvex/server";
import type { ComponentApi } from "../../../../src/component/_generated/component.ts";
import type { ComponentApi as AnonymousApi } from "../../../../src/components/anonymous/_generated/component.ts";
import type { ComponentApi as PasswordApi } from "../../../../src/components/password/_generated/component.ts";
import type { ComponentApi as UsernameApi } from "../../../../src/components/username/_generated/component.ts";
import { setupAnonymous } from "../../../../src/methods/anonymous/server.ts";
import { setupUsernamePassword } from "../../../../src/methods/username-password/server.ts";
import { setupAuth } from "../../../../src/server/setup.ts";
import { getAuthUserId } from "../../../../src/server/userId.ts";

const components = componentsGeneric() as unknown as {
  auth: ComponentApi;
  authPassword: PasswordApi;
  authUsername: UsernameApi;
  authAnonymous: AnonymousApi;
};
// biome-ignore lint/suspicious/noExplicitAny: the app's internal references, as its codegen would type them
const createUser = makeFunctionReference<"mutation">("users:createUser") as any;
// biome-ignore lint/suspicious/noExplicitAny: as above
const onSignIn = makeFunctionReference<"mutation">("users:onSignIn") as any;

const auth = setupAuth({ component: components.auth });
export const { signOut, refreshSession, isAuthenticated } = auth;

export const { signUpWithUsernamePassword, signInWithUsernamePassword, changePassword } = setupUsernamePassword(auth, {
  component: components.authPassword,
  usernameComponent: components.authUsername,
}).attachUserCallbacks({ createUser, onSignIn });

export const { signInAnonymously } = setupAnonymous(auth, { component: components.authAnonymous }).attachUserCallbacks({
  createUser,
});

/** The caller's user id, or null. */
export const me = query({ args: {}, handler: async (ctx) => await getAuthUserId(ctx) });
