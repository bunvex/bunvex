// A component's token: its `iss` names the component.
// biome-ignore-all lint/suspicious/noExplicitAny: `signJwt` is newer than the context types the test builds on
import { mutationGeneric } from "convex/server";

export const sign = mutationGeneric({
  args: {},
  handler: async (ctx) => (ctx.auth as any).signJwt({ claims: { sub: "component" }, expiresInSeconds: 60 }),
});
