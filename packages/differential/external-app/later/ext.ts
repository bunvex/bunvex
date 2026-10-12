"use node";
// External packages (STUDY-148): installed by each deployment from the test's registry. Imported with a comment
// before the name, which the dependency checker does not read as this package's own import.
import { actionGeneric } from "convex/server";
import { read } from /* external */ "tiny-asset";
import { probe } from /* external */ "tiny-bin";
import { read as readEnv } from /* external */ "tiny-env";

export const asset = actionGeneric({
  args: {},
  handler: async () => ({ text: read(), required: require("tiny-asset").read() }),
});
export const bin = actionGeneric({ args: {}, handler: async () => probe() });
export const env = actionGeneric({
  args: {},
  handler: async () => ({
    deployment: readEnv("SECRET_KEY"),
    server: readEnv("SERVER_ONLY_VAR"),
    action: process.env.SERVER_ONLY_VAR ?? null,
  }),
});
