// A function in a nested module.
import { mutationGeneric } from "convex/server";

export const f = mutationGeneric({ args: {}, handler: () => console.log("deep") });
