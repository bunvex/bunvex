// Components' definitions on both (STUDY-153 PR 1): the same `defineApp` / `defineComponent` / `use` calls with
// Convex's package (`convex/server` 1.46.0) and bunvex's, their `export()` and their errors compared. No backend
// needed. The one wording bunvex changes is its runtime's name (DV-494).
import { describe, expect, test } from "bun:test";
import * as b from "bunvex/server";
import * as bv from "bunvex/values";
import * as c from "convex/server";
import * as cv from "convex/values";

type Api = {
  defineApp: (o?: object) => any;
  defineComponent: (name: string, o?: object) => any;
  componentsGeneric: () => any;
  getFunctionAddress: (r: unknown) => unknown;
  v: any;
};
const convex: Api = { ...c, v: cv.v } as unknown as Api;
const bunvex: Api = { ...b, v: bv.v } as unknown as Api;

/** What a scenario gives: its value, or its error's message (bunvex's runtime name read as Convex's). */
function outcome(f: () => unknown): unknown {
  try {
    return { value: f() };
  } catch (e) {
    return { error: (e as Error).message.replace("the bunvex runtime", "Convex runtime") };
  }
}
const imported = (path: string, defaultName?: string) => ({
  componentDefinitionPath: path,
  ...(defaultName ? { defaultName } : {}),
});
const refPath = (r: unknown) => (r as Record<symbol, unknown>)[Symbol.for("toReferencePath")];

const scenarios: Record<string, (api: Api) => unknown> = {
  "an app with two instances and a package path": ({ defineApp }) => {
    const app = defineApp();
    app.use(imported("counter", "counter"));
    app.use(imported("counter", "counter"), { name: "second" });
    app.use(imported("../node_modules/@acme/limiter"));
    return app.export();
  },
  "HTTP prefixes": ({ defineApp }) => {
    const app = defineApp({ httpPrefix: "/api" });
    app.use(imported("counter", "counter"), { httpPrefix: "/c" });
    app.use(imported("counter", "counter"), { name: "o", httpPrefix: "/o/" });
    return app.export();
  },
  "a prefix without /": ({ defineApp }) => defineApp().use(imported("c"), { httpPrefix: "x" }),
  "an app's prefix without /": ({ defineApp }) => defineApp({ httpPrefix: "x" }),
  "env bindings and declarations": ({ defineApp, v }) => {
    const app = defineApp({ env: { APPX: v.string(), MAYBE: v.optional(v.string()) } });
    app.use(imported("counter", "counter"), { env: { X: app.env.APPX, Y: "v", Z: undefined } });
    return app.export();
  },
  "an undeclared variable": ({ defineApp }) => defineApp().env.NOPE,
  "a number as a value": ({ defineApp }) => {
    const app = defineApp();
    app.use(imported("c", "c"), { env: { N: 1 } });
    return app.export();
  },
  "a declaration that is no validator": ({ defineApp }) => defineApp({ env: { X: "nope" } }),
  "a definition the runtime did not hand over": ({ defineApp }) => defineApp().use({}),
  "an empty name": ({ defineApp }) => defineApp().use(imported("c"), { name: "" }),
  "a component with env and a child": ({ defineComponent, v }) => {
    const d = defineComponent("counter", {
      env: { X: v.optional(v.string()), LEVEL: v.union(v.literal("a"), v.literal("b")) },
    });
    d.use(imported("inner", "inner"));
    return d.export();
  },
  "a bare component": ({ defineComponent }) => defineComponent("bare").export(),
  "a component's undeclared variable": ({ defineComponent }) => defineComponent("c").env.X,
  "a component's declared variable": ({ defineComponent, v }) => defineComponent("c", { env: { X: v.string() } }).env.X,
  "a component's declaration that is no validator": ({ defineComponent }) => defineComponent("c", { env: { X: 1 } }),
  "an installed child's references": ({ defineApp }) => {
    const installed = defineApp().use(imported("counter", "counter"), { name: "c" });
    return [refPath(installed), refPath(installed.exports.lib.add)];
  },
  "components references": ({ componentsGeneric }) => refPath(componentsGeneric().counter.lib.add),
  "components alone": ({ componentsGeneric }) => refPath(componentsGeneric()),
  "function addresses": ({ getFunctionAddress, componentsGeneric }) => [
    getFunctionAddress("function://x"),
    getFunctionAddress("m:f"),
    getFunctionAddress(componentsGeneric().counter.lib.add),
  ],
  "an address of something else": ({ getFunctionAddress }) => getFunctionAddress({}),
};

describe("components' definitions, Convex's package and bunvex's", () => {
  for (const [name, scenario] of Object.entries(scenarios))
    test(name, () => {
      expect(outcome(() => scenario(bunvex))).toEqual(outcome(() => scenario(convex)));
    });
});
