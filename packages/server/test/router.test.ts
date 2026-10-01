// HTTP actions' router (STUDY-31 §1.1): Convex's checks and messages, lookup, getRoutes, the start checks.
import { describe, expect, test } from "bun:test";
import { defineSchema, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { makeFunctionReference } from "@bunvex/protocol";
import { action, Functions, internalAction, internalMutation, query } from "../src/functions.ts";
import { checkRouter, httpAction, httpRouter, type RouteSpec } from "../src/router.ts";

const h = httpAction(async () => new Response("ok"));
const h2 = httpAction(async () => new Response("two"));
const err = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return (e as Error).message;
  }
  return "no error";
};

describe("httpRouter().route", () => {
  test("Convex's checks, in Convex's order, with its messages", () => {
    const r = httpRouter();
    const route = (spec: unknown) => err(() => r.route(spec as RouteSpec));
    expect(route({ path: "/a", method: "GET" })).toBe("route requires handler");
    expect(route({ path: "/a", handler: h })).toBe("route requires method");
    expect(route({ path: "/a", method: "HEAD", handler: h })).toBe(
      "'HEAD' is not an allowed HTTP method (like GET, POST, PUT etc.)",
    );
    expect(route({ path: "/a", pathPrefix: "/a/", method: "GET", handler: h })).toBe(
      "Invalid httpRouter route: cannot contain both 'path' and 'pathPrefix'",
    );
    expect(route({ path: "a", method: "GET", handler: h })).toBe("path 'a' does not start with a /");
    expect(route({ path: "/.files", method: "GET", handler: h })).toBe("path '/.files' is reserved");
    expect(route({ path: "/.files/x", method: "GET", handler: h })).toBe("path '/.files/x' is reserved");
    r.route({ path: "/a", method: "GET", handler: h });
    expect(route({ path: "/a", method: "GET", handler: h })).toBe("Path '/a' for method GET already in use");
    expect(route({ pathPrefix: "x/", method: "GET", handler: h })).toBe("pathPrefix 'x/' does not start with a /");
    expect(route({ pathPrefix: "/x", method: "GET", handler: h })).toBe("pathPrefix /x must end with a /");
    expect(route({ pathPrefix: "/.files/", method: "GET", handler: h })).toBe("pathPrefix '/.files/' is reserved");
    r.route({ pathPrefix: "/x/", method: "POST", handler: h });
    expect(route({ pathPrefix: "/x/", method: "POST", handler: h })).toBe("POST pathPrefix /x/ is already defined");
    expect(route({ method: "GET", handler: h })).toBe(
      "Invalid httpRouter route entry: must contain either field 'path' or 'pathPrefix'",
    );
    // An exact path and an overlapping prefix may coexist (Convex checks no cross-type conflict).
    r.route({ pathPrefix: "/a/", method: "GET", handler: h });
  });
});

describe("lookup and getRoutes", () => {
  const r = httpRouter();
  r.route({ path: "/profile", method: "GET", handler: h });
  r.route({ pathPrefix: "/profile/", method: "GET", handler: h2 });
  r.route({ pathPrefix: "/profile/settings/", method: "GET", handler: h });
  r.route({ path: "/a", method: "POST", handler: h });
  r.route({ path: "/a", method: "DELETE", handler: h });
  test("exact first, then the longest prefix; HEAD as GET; null otherwise", () => {
    expect(r.lookup("/profile", "GET")).toEqual([h, "GET", "/profile"]);
    expect(r.lookup("/profile/", "GET")).toEqual([h2, "GET", "/profile/*"]);
    expect(r.lookup("/profile/a/b", "GET")).toEqual([h2, "GET", "/profile/*"]);
    expect(r.lookup("/profile/settings/x", "GET")).toEqual([h, "GET", "/profile/settings/*"]);
    expect(r.lookup("/profile", "HEAD")).toEqual([h, "GET", "/profile"]);
    expect(r.lookup("/profile", "POST")).toBeNull();
    expect(r.lookup("/profiles", "GET")).toBeNull();
  });
  test("getRoutes: exact routes by path then method, then prefixes by method then prefix", () => {
    expect(r.getRoutes().map(([p, m]) => `${m} ${p}`)).toEqual([
      "DELETE /a",
      "POST /a",
      "GET /profile",
      "GET /profile/*",
      "GET /profile/settings/*",
    ]);
  });
});

describe("the checks at start (Convex's analyze of http.js)", () => {
  test("a default export that is a Router, with routes of the expected shape", () => {
    expect(err(() => checkRouter(undefined))).toBe("`bunvex/http.js` must have a default export of a Router.");
    expect(err(() => checkRouter({}))).toBe("The default export of `bunvex/http.js` is not a Router.");
    expect(err(() => checkRouter({ isRouter: "yes" }))).toBe("The default export of `bunvex/http.js` is not a Router.");
    expect(err(() => checkRouter({ isRouter: true }))).toBe(".getRoutes property on Router not found");
    expect(err(() => checkRouter({ isRouter: true, getRoutes: 1 }))).toBe(".get_routes of Router is not a function");
    expect(err(() => checkRouter({ isRouter: true, getRoutes: () => "x" }))).toContain(
      "(return value is not an array)",
    );
    expect(err(() => checkRouter({ isRouter: true, getRoutes: () => [["/a", "TRACE", h]] }))).toContain(
      "('TRACE' is not not a routable method (one of GET, POST, PUT, DELETE, PATCH, OPTIONS))",
    );
    expect(err(() => checkRouter({ isRouter: true, getRoutes: () => [["/a", "GET", () => {}]] }))).toBe(
      "arr[0][2] is not an HttpAction",
    );
    const r = httpRouter();
    r.route({ path: "/a", method: "GET", handler: h });
    expect(checkRouter(r)).toBe(r);
  });

  test("calling an HTTP action directly warns, then runs it", async () => {
    const warn = console.warn;
    const seen: string[] = [];
    console.warn = (m: string) => seen.push(m);
    try {
      const res = await h({} as never, new Request("http://x/"));
      expect(await res.text()).toBe("ok");
    } finally {
      console.warn = warn;
    }
    expect(seen[0]).toContain("should not directly call other bunvex functions");
  });
});

describe("ActionCtx", () => {
  test("runQuery / runMutation / runAction, by reference or by name, internal ones included", async () => {
    const engine = await new Engine(defineSchema({}), await MemoryPersistence.open(null, { durable: false })).init();
    const functions = new Functions(engine).register("m", {
      q: query(async () => "q"),
      im: internalMutation(async () => "m"),
      ia: internalAction(async () => "a"),
      all: action(async (ctx) => [
        await ctx.runQuery(makeFunctionReference<"query">("m:q"), {}),
        await ctx.runMutation("m:im", {}),
        await ctx.runAction(makeFunctionReference<"action">("m:ia"), {}),
      ]),
    });
    expect(await functions.runAction("m:all", {})).toEqual(["q", "m", "a"]);
  });
});
