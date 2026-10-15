// An action that throws, called from an HTTP action (the nested error's message carries its frames).
import { actionGeneric } from "convex/server";

export const fails = actionGeneric(async () => {
  throw new Error("nested boom");
});
