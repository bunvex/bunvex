"use node";
// A "use node" action that logs a line (DV-552).
import { actionGeneric } from "convex/server";

export const a = actionGeneric({ args: {}, handler: () => console.log("node") });
