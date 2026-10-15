// A function, so each CLI has a module to push with the schema.
import { queryGeneric } from "convex/server";

export const one = queryGeneric(async () => 1);
