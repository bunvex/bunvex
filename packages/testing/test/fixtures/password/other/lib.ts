import { mutation } from "@bunvex/server";
import { hashPassword } from "@bunvex/server/password";

export const hash = mutation({
  args: {},
  handler: async () => hashPassword("pw", new Uint8Array(16)),
});
