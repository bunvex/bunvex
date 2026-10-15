// Components' definitions (STUDY-153 PR 1): what `defineApp` / `defineComponent` / `use` give the server, as
// Convex's `server/components/index.ts` (each expectation is its `export()` and its errors; the same calls are
// compared with Convex's own package in packages/differential/test/component-definitions.test.ts).
import { describe, expect, test } from "bun:test";
import { getFunctionAddress, getFunctionName, makeFunctionReference, toReferencePath } from "@bunvex/protocol";
import { v } from "@bunvex/values";
import {
  type ComponentDefinition,
  componentsGeneric,
  currentSystemUdfInComponent,
  defineApp,
  defineComponent,
} from "../src/components.ts";

/** A child definition as the server's evaluation hands it over (Convex's `ImportedComponentDefinition`). */
const imported = (path: string, defaultName?: string) =>
  ({ componentDefinitionPath: path, ...(defaultName ? { defaultName } : {}) }) as unknown as ComponentDefinition;
const exported = (d: unknown) => (d as { export(): unknown }).export();
const referencePath = (r: unknown) => (r as Record<symbol, unknown>)[toReferencePath];

describe("defineApp", () => {
  test("an app with one child: Convex's analysis of it", () => {
    const app = defineApp();
    app.use(imported("counter", "counter"));
    expect(exported(app)).toEqual({
      definitionType: { type: "app" },
      childComponents: [{ name: "counter", path: "counter", args: [], env: [] }],
      httpMounts: {},
      exports: { type: "branch", branch: [] },
    });
  });

  test("a second instance of a definition, by name, in order; a name from the path when there is no default", () => {
    const app = defineApp();
    app.use(imported("counter", "counter"));
    app.use(imported("counter", "counter"), { name: "second" });
    app.use(imported("../node_modules/@acme/limiter"));
    expect((exported(app) as { childComponents: { name: string }[] }).childComponents.map((c) => c.name)).toEqual([
      "counter",
      "second",
      "limiter",
    ]);
  });

  test("HTTP prefixes: normalized to end with /, mounted by reference; one not starting with / is refused", () => {
    const app = defineApp({ httpPrefix: "/api" });
    app.use(imported("counter", "counter"), { httpPrefix: "/c" });
    app.use(imported("counter", "counter"), { name: "other", httpPrefix: "/o/" });
    expect(exported(app)).toMatchObject({
      httpPrefix: "/api/",
      httpMounts: { "/c/": "_reference/childComponent/counter", "/o/": "_reference/childComponent/other" },
    });
    expect(() => app.use(imported("counter"), { httpPrefix: "x" })).toThrow(
      'httpPrefix must start with "/". Received: "x"',
    );
    expect(() => defineApp({ httpPrefix: "x" })).toThrow('httpPrefix must start with "/". Received: "x"');
  });

  test("env: values and the parent's variables by reference; undefined dropped; others refused", () => {
    const app = defineApp({ env: { APPX: v.string(), MAYBE: v.optional(v.string()) } });
    app.use(imported("counter", "counter"), { env: { X: app.env.APPX, Y: "v", Z: undefined } });
    expect(exported(app)).toMatchObject({
      childComponents: [
        {
          env: [
            ["X", { type: "envVar", name: "APPX" }],
            ["Y", { type: "value", value: "v" }],
          ],
        },
      ],
      envVars: [
        ["APPX", { type: "value", value: '{"type":"string"}' }],
        ["MAYBE", { type: "value", value: '{"type":"string"}', optional: true }],
      ],
    });
    expect(() => (app.env as Record<string, unknown>).NOPE).toThrow(
      'Env var "NOPE" is not declared on this app. Add it to the `env` option of defineApp.',
    );
    const bad = defineApp();
    bad.use(imported("counter", "counter"), { env: { N: 1 as unknown as string } });
    expect(() => exported(bad)).toThrow('Env var "N" must be a string or an env var reference. Received: number');
    expect(() => defineApp({ env: { X: "nope" as never } })).toThrow(
      'Environment variable "X" must be defined with a validator (e.g. v.string()).',
    );
  });

  test("use: a definition the runtime did not hand over, and empty names, are refused", () => {
    const app = defineApp();
    expect(() => app.use({} as ComponentDefinition)).toThrow(
      "Component definition does not have the required componentDefinitionPath property. This code only works in the bunvex runtime.",
    );
    expect(() => app.use(imported("counter"), { name: "" })).toThrow("Component name cannot be empty.");
    expect(() => app.use(imported("counter"), { name: 3 as unknown as string })).toThrow(
      "Component name must be a string. Received: number",
    );
  });

  test("an installed child is a reference to it", () => {
    const app = defineApp();
    const installed = app.use(imported("counter", "counter"), { name: "c" });
    expect(referencePath(installed)).toBe("_reference/childComponent/c");
    expect(referencePath(installed.exports.lib.add)).toBe("_reference/childComponent/c/lib/add");
  });
});

describe("defineComponent", () => {
  test("its analysis: a child component's type, env only when declared", () => {
    const c = defineComponent("counter", {
      env: { X: v.optional(v.string()), LEVEL: v.union(v.literal("a"), v.literal("b")) },
    });
    c.use(imported("inner", "inner"));
    expect(exported(c)).toEqual({
      name: "counter",
      definitionType: { type: "childComponent", name: "counter", args: [] },
      childComponents: [{ name: "inner", path: "inner", args: [], env: [] }],
      httpMounts: {},
      exports: { type: "branch", branch: [] },
      envVars: [
        ["X", { type: "value", value: '{"type":"string"}', optional: true }],
        [
          "LEVEL",
          {
            type: "value",
            value: '{"type":"union","value":[{"type":"literal","value":"a"},{"type":"literal","value":"b"}]}',
          },
        ],
      ],
    });
    expect(exported(defineComponent("bare"))).not.toHaveProperty("envVars");
    expect((defineComponent("c", { env: { X: v.string() } }).env as Record<string, unknown>).X).toEqual({
      __envVarRef: "X",
    });
    expect(() => (defineComponent("c").env as Record<string, unknown>).X).toThrow(
      'Env var "X" is not declared on component "c". Add it to the `env` option of defineComponent.',
    );
    expect(() => defineComponent("c", { env: { X: 1 as never } })).toThrow(
      'Environment variable "X" must be defined with a validator (e.g. v.string()).',
    );
  });
});

describe("references", () => {
  test("componentsGeneric: a function's reference path; `components` alone is refused", () => {
    const components = componentsGeneric();
    expect(referencePath(components.counter!.lib!.add)).toBe("_reference/childComponent/counter/lib/add");
    expect(() => referencePath(components)).toThrow(
      "API path is expected to be of the form `components.childComponent.functionName`. Found: `components`",
    );
    expect(referencePath(currentSystemUdfInComponent("abc"))).toBe("_reference/currentSystemUdfInComponent/abc");
  });

  test("getFunctionAddress: a handle, a name, a reference; getFunctionName refuses a component's reference", () => {
    expect(getFunctionAddress("function://x")).toEqual({ functionHandle: "function://x" });
    expect(getFunctionAddress("m:f")).toEqual({ name: "m:f" });
    expect(getFunctionAddress(makeFunctionReference("m:f"))).toEqual({ name: "m:f" });
    const ref = componentsGeneric().counter!.lib!.add;
    expect(getFunctionAddress(ref)).toEqual({ reference: "_reference/childComponent/counter/lib/add" });
    expect(() => getFunctionAddress({})).toThrow("[object Object] is not a functionReference");
    expect(() => getFunctionName(ref as never)).toThrow(
      'Expected function reference in the current component like "api.file.func" or "internal.file.func", but received reference _reference/childComponent/counter/lib/add',
    );
  });
});
