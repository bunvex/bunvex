// A mounted component's path from its reference (STUDY-208 §1.6), upstream's `lib/componentPath.test.ts` at v2.0.0,
// ported: bunvex's references have Convex's `_reference/childComponent/<path>` form.
// biome-ignore-all lint/suspicious/noExplicitAny: the app's api is untyped
import { describe, expect, test } from "bun:test";
import { anyApi, componentsGeneric } from "@bunvex/server";
import { componentPathOf } from "../src/lib/componentPath.ts";

describe("componentPathOf", () => {
  const components = componentsGeneric() as unknown as Record<
    string,
    Record<string, Record<string, Record<string, unknown>>>
  >;

  test("returns the path of a component that the app mounts", () => {
    expect(componentPathOf(components.authPassword!)).toBe("authPassword");
  });

  test("returns the full path of a nested component", () => {
    expect(componentPathOf(components.authPassword!.inner!)).toBe("authPassword/inner");
  });

  // The reference only says it points inside a child component, so a function of the component is not told apart
  // from the component itself.
  test("returns the reference path of a function of a component", () => {
    expect(componentPathOf(components.authPassword!.public!.signIn as object)).toBe("authPassword/public/signIn");
  });

  test("refuses a reference to a function of the app", () => {
    expect(() => componentPathOf((anyApi as any).users.get)).toThrow(
      "Expected a reference inside a component that the app mounts, such as `components.authPassword`.",
    );
  });

  test("refuses the `components` object itself", () => {
    expect(() => componentPathOf(components)).toThrow("Expected a reference inside a component");
  });

  test("refuses something that is not a reference", () => {
    expect(() => componentPathOf({})).toThrow("Expected a reference inside a component");
  });
});
