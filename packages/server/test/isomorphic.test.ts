// `bunvex/server` outside Bun (STUDY-91): the isomorphic entry has every value of the package but the runtime's,
// the same objects, and it bundles for a browser with nothing of the runtime in it. A new export of
// src/index.ts fails the first test until it is added to src/isomorphic.ts or listed here as runtime-only.
import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { anyApi } from "@bunvex/protocol";
import * as full from "../src/index.ts";
import * as isomorphic from "../src/isomorphic.ts";

/** The runtime: the engine, persistence, the server, admin keys. Convex's `convex/server` has none of them. */
const RUNTIME_ONLY = [
  "ADMIN_KEY_PURPOSE",
  "AdminKeys",
  "adminKeyCipherKey",
  "BadAdminKeyError",
  "checkAdminKey",
  "createServer",
  "DEPLOYMENT_OPS",
  "Functions",
  "instanceSecretError",
  "issueAdminKey",
  "LOCAL_BACKEND_USAGE",
  "localBackendMain",
  "openPersistence",
  "parseLocalBackendFlags",
  "persistenceConfigFromEnv",
  "READ_ONLY_OPERATIONS",
  "ScheduledJobExecutor",
  "startLocalBackend",
];
/** Values the isomorphic entry implements on its own (they need a running backend). */
const OWN = ["createFunctionHandle"];

describe("bunvex/server's isomorphic entry", () => {
  test("every value of the package but the runtime's, and the same objects", () => {
    const expected = Object.keys(full)
      .filter((k) => !RUNTIME_ONLY.includes(k))
      .sort();
    expect(Object.keys(isomorphic).sort()).toEqual(expected);
    for (const k of expected.filter((k) => !OWN.includes(k)))
      expect((isomorphic as Record<string, unknown>)[k]).toBe((full as Record<string, unknown>)[k]);
  });

  test("it bundles for a browser, with nothing of the runtime", async () => {
    const out = await Bun.build({
      entrypoints: [resolve(import.meta.dir, "../src/isomorphic.ts")],
      target: "browser",
      conditions: ["browser"],
    });
    expect(out.logs.filter((l) => l.level === "error").map(String)).toEqual([]);
    expect(out.success).toBe(true);
    const code = await out.outputs[0]!.text();
    for (const runtime of ["bun:sqlite", "createServer", "node:async_hooks"]) expect(code).not.toContain(runtime);
  });

  test("createFunctionHandle outside a backend: the reference is checked, then it throws", async () => {
    await expect(isomorphic.createFunctionHandle(anyApi.messages.list)).rejects.toThrow(
      "The bunvex database and auth objects are being used outside of a bunvex backend. " +
        "Did you mean to use `useQuery` or `useMutation` to call a bunvex function?",
    );
    await expect(isomorphic.createFunctionHandle({} as never)).rejects.toThrow();
  });

  test("builders and schemas made through it work as the package's", () => {
    const q = isomorphic.query({ args: {}, handler: async () => 1 });
    expect((q as unknown as { isQuery: boolean }).isQuery).toBe(true);
    const schema = isomorphic.defineSchema({ t: isomorphic.defineTable({}) });
    expect([...schema.tables.keys()]).toEqual(["t"]);
  });
});
