// The umbrella's subpaths are the packages themselves, re-exported: the same objects, never a second copy (STUDY-40:
// two copies of @bunvex/react would not see each other's provider).
import { describe, expect, test } from "bun:test";
import * as client from "@bunvex/client";
import * as react from "@bunvex/react";
import * as server from "@bunvex/server";
import * as values from "@bunvex/values";
import * as browserSubpath from "bunvex/browser";
import * as reactSubpath from "bunvex/react";
import * as serverSubpath from "bunvex/server";
import * as valuesSubpath from "bunvex/values";

describe("bunvex subpaths", () => {
  for (const [name, pkg, sub] of [
    ["bunvex/browser", client, browserSubpath],
    ["bunvex/react", react, reactSubpath],
    ["bunvex/server", server, serverSubpath],
    ["bunvex/values", values, valuesSubpath],
  ] as const) {
    test(`${name} is its package, every export the same object`, () => {
      expect(Object.keys(sub).sort()).toEqual(Object.keys(pkg).sort());
      for (const k of Object.keys(pkg))
        expect((sub as Record<string, unknown>)[k]).toBe((pkg as Record<string, unknown>)[k]);
    });
  }
  test("the entry points Convex's package has for the client", () => {
    expect(browserSubpath.BunvexClient).toBeFunction();
    expect(browserSubpath.BunvexHttpClient).toBeFunction();
    expect(reactSubpath.BunvexProvider).toBeFunction();
    expect(reactSubpath.useQuery).toBeFunction();
  });
});
