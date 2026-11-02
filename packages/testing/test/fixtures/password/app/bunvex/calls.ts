import { componentsGeneric, mutation } from "@bunvex/server";
import { hashPassword } from "@bunvex/server/password";

const components = componentsGeneric();

export const appHash = mutation({
  args: {},
  handler: async () => hashPassword("pw", new Uint8Array(16)),
});

/** The app calls the component, which hashes in its own mutation. */
export const throughComponent = mutation({
  args: {},
  handler: async (ctx) => ctx.runMutation(components.authPassword.lib.hash, { password: "pw" }),
});
