// A push's components tree (STUDY-153 PR 3b): each case of the binary's oracle (STUDY-153 §1.10) that the tree's
// check answers, with Convex's code and text byte for byte (C-5), and the tree as `start_push` answers it.
import { describe, expect, test } from "bun:test";
import type { NewComponentDefinition } from "@bunvex/core";
import type { AnalyzedModule } from "../src/code-version.ts";
import {
  ComponentTreeError,
  checkEnvVarDeclarations,
  componentsOf,
  type EvaluatedDefinition,
  fileBasedExports,
  instantiateRoot,
  serializedCheckedComponent,
} from "../src/component-tree.ts";
import { evaluateDefinitions } from "../src/definition-eval.ts";

type Child = {
  name: string;
  path: string;
  env?: [string, { type: "value"; value: string } | { type: "envVar"; name: string }][];
};
type EnvDecl = [string, { type: "value"; value: string; optional?: true }][];
const STRING = '{"type":"string"}';
const literal = (s: string) => JSON.stringify({ type: "literal", value: s });

/** A definition as `definition-eval.ts` gives it. */
function definition(
  path: string,
  o: { children?: Child[]; env?: EnvDecl; mounts?: Record<string, string>; prefix?: string } = {},
): NewComponentDefinition {
  return {
    path,
    definitionType: path === "" ? { type: "app" } : { type: "childComponent", name: path.split("/").at(-1)!, args: [] },
    childComponents: (o.children ?? []).map((c) => ({ name: c.name, path: c.path, args: [], env: c.env ?? [] })),
    httpMounts: o.mounts ?? {},
    httpPrefix: o.prefix ?? null,
    exports: { type: "branch", branch: [] },
    envVars: o.env ?? [],
  };
}
const fn = (name: string, kind: "public" | "internal" = "public") => ({
  name,
  pos: null,
  udfType: "Mutation" as const,
  visibility: { kind },
  args: "{}",
  returns: "{}",
});
const module = (
  functions: ReturnType<typeof fn>[],
  httpRoutes: AnalyzedModule["httpRoutes"] = null,
): AnalyzedModule => ({
  functions,
  httpRoutes,
  cronSpecs: null,
  rooms: [],
});
const defs = (...ds: [NewComponentDefinition, Record<string, AnalyzedModule>?][]) =>
  new Map<string, EvaluatedDefinition>(ds.map(([d, f]) => [d.path, { definition: d, functions: f ?? {} }]));

/** The tree's refusal: its code and text. */
function refused(f: () => unknown): { code: string; message: string } {
  try {
    f();
  } catch (e) {
    if (e instanceof ComponentTreeError) return { code: e.code, message: e.message };
    throw e;
  }
  throw new Error("accepted");
}

describe("the tree as start_push answers it", () => {
  test("the app mounting `counter` twice: each instance's exports its public functions, Convex's shape", () => {
    const tree = instantiateRoot(
      defs(
        [
          definition("", {
            children: [
              { name: "counter", path: "counter" },
              { name: "second", path: "counter" },
            ],
          }),
          { "app.js": module([fn("hello")]) },
        ],
        [definition("counter"), { "lib.js": module([fn("add"), fn("secret", "internal")]) }],
      ),
    );
    const leaf = (component: string, udfPath: string) => ({
      type: "leaf",
      resource: { type: "function", path: { component, udfPath } },
    });
    const instance = (name: string) => ({
      definitionPath: "counter",
      componentPath: name,
      httpPrefix: null,
      args: {},
      env: {},
      childComponents: {},
      httpRoutes: { httpModuleRoutes: null, mounts: [] },
      exports: { lib: { type: "branch", children: { add: leaf(name, "lib.js:add") } } },
    });
    expect(serializedCheckedComponent(tree)).toEqual({
      definitionPath: "",
      componentPath: "",
      httpPrefix: null,
      args: {},
      env: {},
      childComponents: { counter: instance("counter"), second: instance("second") },
      httpRoutes: { httpModuleRoutes: null, mounts: [] },
      exports: { app: { type: "branch", children: { hello: leaf("", "app.js:hello") } } },
    });
    expect([...componentsOf(tree).keys()]).toEqual(["", "counter", "second"]);
  });

  test("children answered by name, whatever their order in the definition", () => {
    const tree = instantiateRoot(
      defs(
        [
          definition("", {
            children: [
              { name: "zeta", path: "c" },
              { name: "alpha", path: "c" },
            ],
          }),
        ],
        [definition("c")],
      ),
    );
    expect(Object.keys(serializedCheckedComponent(tree).childComponents as object)).toEqual(["alpha", "zeta"]);
  });

  test("HTTP mounts: a child's prefix is its mount path, composed with its parent's below the root", () => {
    const routes = module([], [{ route: { path: "/hook", method: "POST" }, pos: null }]);
    const tree = instantiateRoot(
      defs(
        [
          definition("", {
            children: [{ name: "a", path: "a" }],
            mounts: { "/api/": "_reference/childComponent/a" },
            prefix: "/app/",
          }),
        ],
        [
          definition("a", { children: [{ name: "b", path: "b" }], mounts: { "/b/": "_reference/childComponent/b" } }),
          { "http.js": routes },
        ],
        [definition("b"), { "http.js": routes }],
      ),
    );
    const s = serializedCheckedComponent(tree) as {
      httpPrefix: string;
      httpRoutes: unknown;
      childComponents: Record<string, Record<string, unknown>>;
    };
    expect(s.httpPrefix).toBe("/app/");
    expect(s.httpRoutes).toEqual({ httpModuleRoutes: null, mounts: ["/api/"] });
    const a = s.childComponents.a!;
    expect(a.httpPrefix).toBe("/api/");
    expect(a.httpRoutes).toEqual({ httpModuleRoutes: [{ path: "/hook", method: "POST" }], mounts: ["/b/"] });
    expect((a.childComponents as Record<string, { httpPrefix: string }>).b!.httpPrefix).toBe("/api/b/");
  });

  test("env bindings resolved down the tree: the app's stay deployment variables, below they take the parent's", () => {
    const tree = instantiateRoot(
      defs(
        [
          definition("", {
            env: [
              ["APPX", { type: "value", value: STRING }],
              ["OPT", { type: "value", value: STRING, optional: true }],
            ],
            children: [
              {
                name: "counter",
                path: "counter",
                env: [
                  ["X", { type: "envVar", name: "APPX" }],
                  ["O", { type: "envVar", name: "OPT" }],
                ],
              },
            ],
          }),
        ],
        [
          definition("counter", {
            env: [
              ["X", { type: "value", value: STRING }],
              ["O", { type: "value", value: STRING, optional: true }],
            ],
            children: [
              {
                name: "inner",
                path: "inner",
                env: [
                  ["Y", { type: "envVar", name: "X" }],
                  ["P", { type: "envVar", name: "O" }],
                ],
              },
            ],
          }),
        ],
        [
          definition("inner", {
            env: [
              ["Y", { type: "value", value: STRING }],
              ["P", { type: "value", value: STRING, optional: true }],
            ],
          }),
        ],
      ),
    );
    const counter = tree.childComponents.get("counter")!;
    expect(Object.fromEntries(counter.env)).toEqual({
      O: { type: "envVar", name: "OPT" },
      X: { type: "envVar", name: "APPX" },
    });
    // Answered by name, as Convex's `BTreeMap` (bound as `X`, then `O`).
    const answered = serializedCheckedComponent(tree).childComponents as Record<string, { env: object }>;
    expect(Object.keys(answered.counter!.env)).toEqual(["O", "X"]);
    // `inner.Y ← counter.X ← APPX`; `inner.P ← counter.O ← OPT`: both the app's variables two levels down.
    expect(Object.fromEntries(counter.childComponents.get("inner")!.env)).toEqual({
      P: { type: "envVar", name: "OPT" },
      Y: { type: "envVar", name: "APPX" },
    });
  });

  test("a binding to a parent's optional variable the parent left unbound is dropped", () => {
    const tree = instantiateRoot(
      defs(
        [definition("", { children: [{ name: "c", path: "c" }] })],
        [
          definition("c", {
            env: [["O", { type: "value", value: STRING, optional: true }]],
            children: [{ name: "i", path: "i", env: [["P", { type: "envVar", name: "O" }]] }],
          }),
        ],
        [definition("i", { env: [["P", { type: "value", value: STRING, optional: true }]] })],
      ),
    );
    expect(tree.childComponents.get("c")!.childComponents.get("i")!.env.size).toBe(0);
  });

  test("end to end from bunvex/server's definitions: a literal value bound, an app variable passed down", async () => {
    const dep = (p: string) => `./_componentDeps/${Buffer.from(p).toString("base64url")}`;
    const evaluated = await evaluateDefinitions({
      app: {
        definition: {
          source: `import { defineApp } from "bunvex/server";\nimport { v } from "bunvex/values";\nimport counter from "${dep("counter")}";\nconst app = defineApp({ env: { APPX: v.string() } });\napp.use(counter, { env: { MODE: "fast", KEY: app.env.APPX } });\nexport default app;`,
        },
        dependencies: ["counter"],
      },
      components: new Map([
        [
          "counter",
          {
            definition: {
              source: `import { defineComponent } from "bunvex/server";\nimport { v } from "bunvex/values";\nexport default defineComponent("counter", { env: { MODE: v.union(v.literal("fast"), v.literal("slow")), KEY: v.string() } });`,
            },
            dependencies: [],
          },
        ],
      ]),
      env: {},
    });
    const all = new Map([...evaluated].map(([p, d]) => [p, { definition: d, functions: {} }]));
    checkEnvVarDeclarations(all);
    const tree = instantiateRoot(all);
    expect(Object.fromEntries(tree.childComponents.get("counter")!.env)).toEqual({
      KEY: { type: "envVar", name: "APPX" },
      MODE: { type: "value", value: "fast" },
    });
  });
});

describe("refused, as the binary refuses them", () => {
  test("a non-string env declaration, the app's and a component's", () => {
    const num: EnvDecl = [["X", { type: "value", value: '{"type":"number"}' }]];
    expect(refused(() => checkEnvVarDeclarations(defs([definition("", { env: num })])))).toEqual({
      code: "InvalidEnvVarDeclaration",
      message:
        'Env var `X` on the app has a non-string validator. Component env vars must be declared with `v.string()`, `v.literal("...")`, or a union of those.',
    });
    expect(
      refused(() => checkEnvVarDeclarations(defs([definition("")], [definition("counter", { env: num })]))).message,
    ).toStartWith("Env var `X` on component counter has a non-string validator.");
    // A number literal, or a union holding a number, is not.
    for (const value of [
      { type: "literal", value: 1 },
      { type: "union", value: [{ type: "string" }, { type: "number" }] },
    ])
      expect(
        refused(() =>
          checkEnvVarDeclarations(
            defs([definition("", { env: [["X", { type: "value", value: JSON.stringify(value) }]] })]),
          ),
        ).code,
      ).toBe("InvalidEnvVarDeclaration");
    // Definitions are checked by path: the app's first.
    expect(
      refused(() =>
        checkEnvVarDeclarations(defs([definition("counter", { env: num })], [definition("", { env: num })])),
      ).message,
    ).toStartWith("Env var `X` on the app ");
    // A union of strings and literals is string-like.
    checkEnvVarDeclarations(
      defs([
        definition("", {
          env: [
            [
              "U",
              {
                type: "value",
                value: JSON.stringify({ type: "union", value: [{ type: "string" }, { type: "literal", value: "a" }] }),
              },
            ],
          ],
        }),
      ]),
    );
  });

  const app = (child: Child, env?: EnvDecl) => definition("", { children: [child], ...(env ? { env } : {}) });

  test("a required variable unbound, an undeclared one bound, a value its literal refuses", () => {
    const counter = definition("counter", { env: [["X", { type: "value", value: literal("a") }]] });
    expect(refused(() => instantiateRoot(defs([app({ name: "counter", path: "counter" })], [counter])))).toEqual({
      code: "TypecheckError",
      message: 'Component [ComponentName(Identifier("counter"))] is missing required env var Identifier("X")',
    });
    expect(
      refused(() =>
        instantiateRoot(
          defs([app({ name: "counter", path: "counter", env: [["Y", { type: "value", value: "a" }]] })], [counter]),
        ),
      ).message,
    ).toBe('Component [ComponentName(Identifier("counter"))] has no env var named Identifier("Y")');
    expect(
      refused(() =>
        instantiateRoot(
          defs([app({ name: "counter", path: "counter", env: [["X", { type: "value", value: "b" }]] })], [counter]),
        ),
      ).message,
    ).toBe(
      'Component [ComponentName(Identifier("counter"))] has an invalid value for env var Identifier("X"): `"b"` does not match literal validator `v.literal("a")`.',
    );
  });

  test("a binding to the parent's variables: undeclared, optional for a required one, a wider validator", () => {
    const counter = definition("counter", { env: [["X", { type: "value", value: literal("a") }]] });
    const bound = { name: "counter", path: "counter", env: [["X", { type: "envVar", name: "APPX" }]] } as Child;
    expect(refused(() => instantiateRoot(defs([app(bound)], [counter]))).message).toBe(
      'Component [ComponentName(Identifier("counter"))] env var Identifier("X") references undeclared parent env var APPX',
    );
    expect(
      refused(() =>
        instantiateRoot(
          defs([app(bound, [["APPX", { type: "value", value: literal("a"), optional: true }]])], [counter]),
        ),
      ).message,
    ).toBe(
      'Component [ComponentName(Identifier("counter"))] env var Identifier("X") is required, but parent env var APPX is optional',
    );
    expect(
      refused(() => instantiateRoot(defs([app(bound, [["APPX", { type: "value", value: STRING }]])], [counter])))
        .message,
    ).toBe(
      'Component [ComponentName(Identifier("counter"))] env var Identifier("X") validator is not satisfied by parent env var APPX validator',
    );
    // A literal is within a string: accepted.
    instantiateRoot(
      defs(
        [app(bound, [["APPX", { type: "value", value: literal("a") }]])],
        [definition("counter", { env: [["X", { type: "value", value: STRING }]] })],
      ),
    );
  });

  test("two children of one name, an unknown definition, Convex's Debug forms", () => {
    expect(
      refused(() =>
        instantiateRoot(
          defs(
            [
              definition("", {
                children: [
                  { name: "counter", path: "counter" },
                  { name: "counter", path: "counter" },
                ],
              }),
            ],
            [definition("counter")],
          ),
        ),
      ),
    ).toEqual({
      code: "TypecheckError",
      message:
        'Component ComponentDefinitionPath { path: "" } has multiple child components with the same name: ComponentName(Identifier("counter"))',
    });
    expect(refused(() => instantiateRoot(defs([app({ name: "c", path: "nope" })]))).message).toBe(
      'Component definition not found: ComponentDefinitionPath { path: "nope" }',
    );
  });

  test("HTTP mounts: a child with no routes, an overlap with the parent's prefix route", () => {
    const mounted = (mounts: Record<string, string>) =>
      definition("", { children: [{ name: "c", path: "c" }], mounts });
    expect(
      refused(() => instantiateRoot(defs([mounted({ "/c/": "_reference/childComponent/c" })], [definition("c")]))),
    ).toEqual({
      code: "TypecheckError",
      message:
        'HTTP mount HttpMountPath("/c/") is invalid: Child component ComponentName(Identifier("c")) doesn\'t have any HTTP routes.',
    });
    const routes = { "http.js": module([], [{ route: { path: "/c/*", method: "GET" }, pos: null }]) };
    expect(
      refused(() =>
        instantiateRoot(defs([mounted({ "/c/": "_reference/childComponent/c" }), routes], [definition("c"), routes])),
      ).message,
    ).toBe('HTTP mount HttpMountPath("/c/") is invalid: Overlap with existing prefix route');
    expect(
      refused(() => instantiateRoot(defs([mounted({ "/x/": "_reference/childComponent/zz" })], [definition("c")])))
        .message,
    ).toBe('HTTP mount HttpMountPath("/x/") is invalid: Child component ComponentName(Identifier("zz")) not found.');
  });

  test("exports: a function where a module's branch is is InvalidExport", () => {
    expect(refused(() => fileBasedExports({ "a.js": module([fn("b")]), "a/b.js": module([fn("c")]) }))).toEqual({
      code: "InvalidExport",
      message: "Path a/b.js:c conflicts with existing export",
    });
  });
});
