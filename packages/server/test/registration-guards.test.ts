// Convex's registration guards (STUDY-66 §7, registration_impl.ts): a registered function called directly
// warns and runs its handler; defining functions in a real browser logs an error.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";
import { action, Functions, internalMutation, isFunctionDef, mutation, query } from "../src/functions.ts";
import { createServer } from "../src/server.ts";

const restore: (() => void)[] = [];
afterEach(() => {
  for (const r of restore.splice(0)) r();
});

const warning = (builder: string) =>
  "bunvex functions should not directly call other bunvex functions. Consider calling a helper function instead. " +
  `e.g. \`export const foo = ${builder}(...); await foo(ctx);\` is not supported.`;

describe("calling a registered function directly", () => {
  test("it warns, with the builder's name, and runs the handler", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    restore.push(() => warn.mockRestore());
    const double = query({ args: { n: v.number() }, handler: (_ctx, { n }) => n * 2 });
    const bump = internalMutation((_ctx, { n }: { n: number }) => n + 1);
    const call = (f: unknown, args: unknown) => (f as (ctx: unknown, args: unknown) => unknown)({}, args);
    expect(call(double, { n: 2 })).toBe(4);
    expect(call(bump, { n: 2 })).toBe(3);
    expect(warn.mock.calls.map((c) => c[0])).toEqual([warning("query"), warning("internalMutation")]);
  });

  test("it is still a registered function: its kind, markers, validators", async () => {
    const f = action({ args: { s: v.string() }, handler: () => 1 });
    expect(typeof f).toBe("function");
    expect(isFunctionDef(f)).toBe(true);
    expect(f).toMatchObject({
      kind: "action",
      visibility: "public",
      isBunvexFunction: true,
      isAction: true,
      isPublic: true,
    });
    expect(isFunctionDef(() => 1)).toBe(false);
  });

  test("from another function, the warning is the caller's log line", async () => {
    const engine = await new Engine(
      defineSchema({ items: defineTable(v.any()) }),
      await MemoryPersistence.open(null, { durable: false }),
    ).init();
    const helper = query(async ({ db }) => (await db.query("items").collect()).length);
    const functions = new Functions(engine).register("m", {
      helper,
      direct: query(async (ctx) => (helper as unknown as (c: unknown, a: unknown) => Promise<number>)(ctx, {})),
      add: mutation(({ db }) => db.insert("items", {})),
    });
    const { server, stop } = createServer({ engine, functions, port: 0, redactLogsToClient: false });
    restore.push(stop);
    await functions.runMutation("m:add", {});
    const r = await fetch(`http://127.0.0.1:${server!.port}/api/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "m:direct", args: {} }),
    });
    expect(await r.json()).toEqual({ status: "success", value: 1, logLines: [`[WARN] '${warning("query")}'`] });
  });
});

describe("defining functions in a browser", () => {
  const withWindow = (native: boolean, allow = false) => {
    const w = allow ? { __bunvexAllowFunctionsInBrowser: true } : {};
    const get = () => w;
    // A real browser's `window` getter is native code; JSDOM's is not.
    if (native) Object.defineProperty(get, "toString", { value: () => "function get window() { [native code] }" });
    Object.defineProperty(globalThis, "window", { configurable: true, get });
    restore.push(() => delete (globalThis as { window?: unknown }).window);
  };

  test("a real browser: console.error; JSDOM or the opt-out: nothing", () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    restore.push(() => error.mockRestore());
    withWindow(true);
    query(() => 1);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]![0]).toStartWith("bunvex functions should not be imported in the browser.");
    delete (globalThis as { window?: unknown }).window;
    withWindow(false);
    query(() => 1);
    delete (globalThis as { window?: unknown }).window;
    withWindow(true, true);
    query(() => 1);
    expect(error).toHaveBeenCalledTimes(1);
  });
});
