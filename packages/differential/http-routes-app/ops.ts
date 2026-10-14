// A query, so the app has a function module beside its routes.
import { queryGeneric } from "convex/server";

export const q = queryGeneric({ args: {}, handler: async () => null });
