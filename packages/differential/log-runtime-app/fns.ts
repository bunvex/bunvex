// A query, a mutation and a V8 action that each log a line (DV-552): the runtime their log stream events name.
import { actionGeneric, mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";

export const q = queryGeneric({ args: {}, handler: () => console.log("q") });
export const m = mutationGeneric({ args: {}, handler: () => console.log("m") });
export const a = actionGeneric({ args: { n: v.number() }, handler: () => console.log("a") });
