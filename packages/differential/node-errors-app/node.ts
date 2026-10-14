"use node";
// A "use node" action's process-level failures (platform §9): an exception thrown in a callback, `process.exit`, an
// unhandled rejection; and a plain action, to see that the next call works.
import fs from "node:fs";
import { actionGeneric } from "convex/server";

export const callback = actionGeneric({
  args: {},
  handler: async () =>
    new Promise(() => {
      fs.exists("asdf", () => {
        throw new Error("Yikes");
      });
    }),
});
export const exit = actionGeneric({
  args: {},
  handler: async () => {
    process.exit(3);
  },
});
export const exitNoCode = actionGeneric({
  args: {},
  handler: async () => {
    process.exit();
  },
});
export const rejection = actionGeneric({
  args: {},
  handler: async () => {
    void Promise.reject(new Error("nope"));
    await new Promise((r) => setTimeout(r, 200));
    return "done";
  },
});
export const ok = actionGeneric({ args: {}, handler: async () => "ok" });
