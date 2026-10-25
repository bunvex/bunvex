// Evaluating components' definitions (STUDY-153 PR 3a): each case of the binary's oracle (STUDY-153 §1.10) that the
// evaluator answers, with Convex's code and message in bunvex's words (DV-494), and what an evaluated definition
// reads back as.
import { describe, expect, test } from "bun:test";
import {
  DefinitionError,
  type DefinitionsInput,
  definitionPathError,
  evaluateDefinitions,
} from "../src/definition-eval.ts";

/** A child's import, as Convex's CLI bundles it. */
const dep = (path: string) => `./_componentDeps/${Buffer.from(path).toString("base64url")}`;
/** A definition module that default-exports `{export: () => <body>}`, its export's result written by hand. */
const plain = (body: string, prelude = "") => ({ source: `${prelude}\nexport default { export: () => (${body}) };` });
const APP = `{ definitionType: { type: "app" }, childComponents: [], httpMounts: {}, exports: { type: "branch", branch: [] } }`;
const component = (name: string) =>
  `{ name: ${JSON.stringify(name)}, definitionType: { type: "childComponent", name: ${JSON.stringify(name)}, args: [] }, childComponents: [], httpMounts: {}, exports: { type: "branch", branch: [] } }`;

const input = (
  app: { source: string; sourceMap?: string },
  appDependencies: string[] = [],
  components: Record<string, { source: string; dependencies?: string[] }> = {},
  env: Record<string, string> = {},
): DefinitionsInput => ({
  app: { definition: app, dependencies: appDependencies },
  components: new Map(
    Object.entries(components).map(([p, c]) => [
      p,
      { definition: { source: c.source }, dependencies: c.dependencies ?? [] },
    ]),
  ),
  env,
});

/** The push's error: its code and message. */
async function refused(i: DefinitionsInput): Promise<{ code: string; message: string }> {
  try {
    await evaluateDefinitions(i);
  } catch (e) {
    if (e instanceof DefinitionError) return { code: e.code, message: e.message };
    throw e;
  }
  throw new Error("evaluated");
}

describe("evaluating definitions", () => {
  test("the app mounting one component twice with bunvex/server's defineApp: each definition as Convex reads it", async () => {
    const app = {
      source: `import { defineApp } from "bunvex/server";\nimport counter from "${dep("counter")}";\nconst app = defineApp();\napp.use(counter);\napp.use(counter, { name: "second" });\nexport default app;`,
    };
    const counter = {
      source: `import { defineComponent } from "bunvex/server";\nexport default defineComponent("counter");`,
    };
    const out = await evaluateDefinitions(input(app, ["counter"], { counter }));
    expect([...out.keys()]).toEqual(["counter", ""]);
    expect(out.get("")).toEqual({
      path: "",
      definitionType: { type: "app" },
      childComponents: [
        { name: "counter", path: "counter", args: [], env: [] },
        { name: "second", path: "counter", args: [], env: [] },
      ],
      httpMounts: {},
      httpPrefix: null,
      exports: { type: "branch", branch: [] },
      envVars: [],
    });
    expect(out.get("counter")).toMatchObject({
      path: "counter",
      definitionType: { type: "childComponent", name: "counter", args: [] },
      childComponents: [],
    });
  });

  test("a hand-written plain object is a definition too (Convex reads only `export`)", async () => {
    const out = await evaluateDefinitions(input(plain(APP)));
    expect(out.get("")!.definitionType).toEqual({ type: "app" });
  });

  test("no code from strings while a definition is evaluated, as in Convex's isolate", async () => {
    const out = await refused(
      input({
        source: `let r; try { r = eval("1"); } catch (e) { r = e.name + ": " + e.message; }\nexport default { export: () => { throw new Error(r); } };`,
      }),
    );
    expect(out.message).toContain("EvalError: Code generation from strings disallowed for this context");
  });

  test("an imported child is Convex's synthetic module: its serialized definition, its path and default name", async () => {
    const x = {
      source: `export default { export: () => ({ ...${component("xcomp")}, envVars: [["B", { type: "value", value: '{"type":"string"}' }], ["A", { type: "value", value: '{"type":"string"}', optional: true }]] }) };`,
    };
    // What the app's definition sees of its child, shown through an exception's message.
    const app = {
      source: `import inner from "${dep("../x/dist")}";\nconst s = JSON.stringify({ e: inner.export(), p: inner.componentDefinitionPath, n: inner.defaultName });\nexport default { export: () => { throw new Error(s); } };`,
    };
    const { code, message } = await refused(input(app, ["../x/dist"], { "../x/dist": x }));
    expect(code).toBe("InvalidBunvexConfig");
    expect(JSON.parse(message.split("\n")[0]!.replace(/^Uncaught Error: /, ""))).toEqual({
      e: {
        path: "../x/dist",
        definitionType: { type: "childComponent", name: "xcomp", args: [] },
        childComponents: [],
        httpMounts: {},
        httpPrefix: null,
        exports: { type: "branch", branch: [] },
        // By key, as Convex's `BTreeMap`; the optional flag only when set.
        envVars: [
          ["A", { type: "value", value: '{"type":"string"}', optional: true }],
          ["B", { type: "value", value: '{"type":"string"}' }],
        ],
      },
      p: "../x/dist",
      n: "xcomp",
    });
  });

  test("a child with no variables declared: `envVars` null in what its parent sees", async () => {
    const x = { source: `export default { export: () => (${component("xcomp")}) };` };
    const app = {
      source: `import inner from "${dep("x")}";\nconst s = JSON.stringify(inner.export().envVars);\nexport default { export: () => { throw new Error(s); } };`,
    };
    expect((await refused(input(app, ["x"], { x }))).message).toStartWith("Uncaught Error: null\n");
  });
});

describe("refused, as the binary refuses them", () => {
  test("a cycle: a definition depending on itself, and two depending on each other", async () => {
    const self = await refused(
      input(plain(APP), ["a"], { a: { source: plain(component("a")).source, dependencies: ["a"] } }),
    );
    expect(self).toEqual({ code: "CyclicImport", message: "Found cyclic definition dependency" });
    const two = await refused(
      input(plain(APP), ["a"], {
        a: { source: plain(component("a")).source, dependencies: ["b"] },
        b: { source: plain(component("b")).source, dependencies: ["a"] },
      }),
    );
    expect(two.code).toBe("CyclicImport");
  });

  test("a diamond is no cycle: a shared child is evaluated again, not refused", async () => {
    const out = await evaluateDefinitions(
      input(plain(APP), ["a", "b"], {
        a: { source: plain(component("a")).source, dependencies: ["c"] },
        b: { source: plain(component("b")).source, dependencies: ["c"] },
        c: { source: plain(component("c")).source },
      }),
    );
    expect([...out.keys()].sort()).toEqual(["", "a", "b", "c"]);
  });

  test("an exception thrown by the definition's code: InvalidBunvexConfig, Convex's uncaught error", async () => {
    const { code, message } = await refused(
      input({ source: `throw new Error("boom in config");\nexport default {};` }),
    );
    expect(code).toBe("InvalidBunvexConfig");
    expect(message).toStartWith("Uncaught Error: boom in config\n    at ");
    expect(message).toContain("bunvex.config.js:1:");
    expect(message).not.toContain("definition-eval.ts");
  });

  test("the five shapes of a default export Convex refuses, the app's and a component's words", async () => {
    const cases: [string, string][] = [
      ["export const x = 1;", "missing default export"],
      ["export default 1;", "the default export is not an object"],
      ["export default {}; export const x = 1;", "`bunvex.config.ts` has more than one export"],
      ["export default {};", "missing `export` property on the default export of `bunvex.config.ts`"],
      [
        "export default { export: 1 };",
        "`app.export` (where `app` is the default export of `bunvex.config.ts`) is not a function",
      ],
      [
        "export default { export: () => 1 };",
        "`app.export()` (where `app` is the default export of `bunvex.config.ts`) doesn’t return an object",
      ],
    ];
    for (const [source, problem] of cases)
      expect(await refused(input({ source }))).toEqual({
        code: "InvalidDefinition",
        message: `The default export of \`bunvex.config.ts\` in your app has an invalid value (${problem}). Please make sure that you’re exporting the return value of \`defineApp()\` (\`import { defineApp } from 'bunvex/server'\`).`,
      });
    expect(await refused(input(plain(APP), ["c"], { c: { source: "export default 1;" } }))).toEqual({
      code: "InvalidDefinition",
      message:
        "The default export of `bunvex.config.ts` in component `c` has an invalid value (the default export is not an object). Please make sure that the component is exporting the return value of `defineComponent()` (`import { defineComponent } from 'bunvex/server'`).",
    });
  });

  test("a result serde cannot read: Convex's text, the path injected last", async () => {
    expect(await refused(input(plain(`{ definitionType: { type: "app" } }`)))).toEqual({
      code: "InvalidDefinition",
      message: 'Failed to deserialize {"definitionType":{"type":"app"},"path":""}: missing field `childComponents`',
    });
    const unknownType = await refused(input(plain(`{ ...${APP}, definitionType: { type: "library" } }`)));
    expect(unknownType.message).toEndWith(": unknown variant `library`, expected `app` or `childComponent`");
    const notString = await refused(input(plain(`{ ...${APP}, httpPrefix: 3 }`)));
    expect(notString.message).toEndWith(": invalid type: integer `3`, expected a string");
  });

  test("names, paths and prefixes Convex's TryFrom refuses, in its words", async () => {
    const child = (name: string) =>
      plain(`{ ...${APP}, childComponents: [{ name: ${JSON.stringify(name)}, path: "c", args: [], env: [] }] }`);
    expect(await refused(input(child("my-comp")))).toEqual({
      code: "InvalidDefinition",
      message:
        "Identifier my-comp has invalid character '-': Identifiers can only contain alphanumeric characters or underscores",
    });
    expect((await refused(input(child("")))).message).toBe("Identifier cannot be empty");
    expect(await refused(input(plain(`{ ...${APP}, httpPrefix: "c" }`)))).toEqual({
      code: "InvalidDefinition",
      message: "Condition failed: `s.starts_with('/')`",
    });
    expect((await refused(input(plain(`{ ...${APP}, httpPrefix: "/c" }`)))).message).toBe(
      "Condition failed: `s.ends_with('/')`",
    );
    expect((await refused(input(plain(`{ ...${APP}, httpMounts: { "/c/": "c" } }`)))).message).toBe(
      "Invalid reference: c",
    );
    expect(
      (await refused(input(plain(`{ ...${APP}, childComponents: [{ name: "c", path: "/abs", args: [], env: [] }] }`))))
        .message,
    ).toBe("Component paths must be relative (/abs is absolute).");
    expect(
      (await refused(input(plain(`{ ...${APP}, exports: { type: "leaf", leaf: "_reference/function/a.js:f" } }`))))
        .message,
    ).toBe("Expected branch of exports at the top level");
  });

  test("time, randomness and the outside: refused into the code, so an InvalidBunvexConfig", async () => {
    const cases: [string, string][] = [
      ["new Date()", "Date unsupported when evaluating app definition"],
      ["Date.now()", "Date unsupported when evaluating app definition"],
      ["Date()", "Date unsupported when evaluating app definition"],
      ["Math.random()", "Math.random unsupported when evaluating app definition"],
      [
        "crypto.getRandomValues(new Uint8Array(4))",
        "Cannot use cryptographic randomness when evaluating app definition",
      ],
      ["crypto.randomUUID()", "Cannot use cryptographic randomness when evaluating app definition"],
      ["performance.now()", "The Performance API is not supported when evaluating app definition"],
      ["fetch('http://x')", "fetch() unsupported while evaluating app definition"],
      ["setTimeout(() => {}, 1)", "setTimeout unsupported while evaluating app definition"],
    ];
    for (const [call, text] of cases) {
      const { code, message } = await refused(input(plain(APP, `${call};`)));
      expect(code).toBe("InvalidBunvexConfig");
      expect(message).toStartWith(`Uncaught Error: ${text}\n`);
    }
    // A date given its time reads nothing: allowed, as on Convex.
    expect((await evaluateDefinitions(input(plain(APP, "new Date(0).toISOString();")))).size).toBe(1);
  });

  test("a top-level await: Convex's text", async () => {
    expect(await refused(input(plain(APP, "await 1;")))).toEqual({
      code: "InvalidBunvexConfig",
      message: "Top-level awaits in source files are unsupported\n",
    });
  });

  test("an import of anything but a child or bunvex/*: NoImportModuleDuringDefinitionEvaluation, located", async () => {
    expect(await refused(input({ source: `import x from "./other.js";export default x;` }))).toEqual({
      code: "NoImportModuleDuringDefinitionEvaluation",
      message: "bunvex:/bunvex.config.js:0:14: Can't import other.js while evaluating app definition",
    });
  });

  test("a bare import: refused as any other, a 400 (DV-497)", async () => {
    for (const spec of ["lodash", "node:fs"])
      expect(await refused(input({ source: `import x from "${spec}";export default x;` }))).toEqual({
        code: "NoImportModuleDuringDefinitionEvaluation",
        message: `bunvex:/bunvex.config.js:0:14: Can't import ${spec} while evaluating app definition`,
      });
  });

  test("an export() that throws: the exception, an InvalidBunvexConfig (DV-498)", async () => {
    const { code, message } = await refused(
      input({ source: `export default { export: () => { throw new Error("no"); } };` }),
    );
    expect(code).toBe("InvalidBunvexConfig");
    expect(message).toStartWith("Uncaught Error: no\n    at ");
  });

  test("process.env: the deployment's in the app's definition, refused in a component's", async () => {
    const app = plain(`{ ...${APP}, httpPrefix: process.env.PREFIX }`);
    const out = await evaluateDefinitions(input(app, [], {}, { PREFIX: "/api/" }));
    expect(out.get("")!.httpPrefix).toBe("/api/");
    const { code, message } = await refused(input(plain(APP), ["c"], { c: plain(component("c"), "process.env.X;") }));
    expect(code).toBe("InvalidBunvexConfig");
    expect(message).toStartWith(
      "Uncaught Error: Environment variables are only supported in the app's bunvex.config.ts.\n",
    );
  });

  test("console is accepted and dropped", async () => {
    expect((await evaluateDefinitions(input(plain(APP, "console.log('hi'); console.error('x');")))).size).toBe(1);
  });

  test("a dependency or child import naming no pushed definition: a 400 InvalidDefinition (DV-496)", async () => {
    expect(await refused(input(plain(APP), ["nope"]))).toEqual({
      code: "InvalidDefinition",
      message: "Component definition nope does not name a pushed component definition",
    });
    const imported = await refused(input({ source: `import x from "${dep("nope")}";export default x;` }));
    expect(imported).toEqual({
      code: "InvalidDefinition",
      message: `bunvex:/bunvex.config.js:0:14: Component definition nope does not name a pushed component definition`,
    });
    expect((await refused(input({ source: `import x from "./_componentDeps/!!";export default x;` }))).code).toBe(
      "InvalidModule",
    );
  });
});

describe("definition paths (Convex's ComponentDefinitionPath)", () => {
  test("relative, `..` allowed, each segment non-control ASCII", () => {
    expect(definitionPathError("")).toBeNull();
    expect(definitionPathError("counter")).toBeNull();
    expect(definitionPathError("../node_modules/@x/y/dist/component")).toBeNull();
    expect(definitionPathError("/abs")).toBe("Component paths must be relative (/abs is absolute).");
    expect(definitionPathError("./x")).toBe("Invalid path component CurDir in ./x.");
    expect(definitionPathError("a\\b")).toBe("Path component a\\b can only include non-control ASCII characters.");
    expect(definitionPathError("é")).toBe("Path component é can only include non-control ASCII characters.");
  });
});
