// Functions that each log a line: their log stream events' `function.path` and `function.cached`.
import { actionGeneric, mutationGeneric, queryGeneric } from "convex/server";

export const q = queryGeneric({ args: {}, handler: () => console.log("q") });
export const m = mutationGeneric({ args: {}, handler: () => console.log("m") });
export const a = actionGeneric({ args: {}, handler: () => console.log("a") });
