// A public query and an internal one, for the app to call through `components.cmp.lib`.
import { internalQueryGeneric, queryGeneric } from "convex/server";

export const pub = queryGeneric(async () => "cmp:pub");
export const priv = internalQueryGeneric(async () => "cmp:priv");
