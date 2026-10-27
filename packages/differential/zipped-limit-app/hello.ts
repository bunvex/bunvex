// One query, in a package that zips past 100 bytes (STUDY-186 A3): the push is not refused for its zipped size.
import { queryGeneric } from "convex/server";

export const hello = queryGeneric({ args: {}, handler: () => "hello" });
