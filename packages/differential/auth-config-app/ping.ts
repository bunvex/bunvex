import { queryGeneric as query } from "convex/server";

export const ping = query({ args: {}, handler: async () => "pong" });
