// A default export: its path has no function name once stripped.
import { queryGeneric } from "convex/server";

export default queryGeneric({ args: {}, handler: () => console.log("default") });
