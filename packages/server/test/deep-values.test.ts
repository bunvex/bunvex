// Arguments too deep to stringify are refused before a stringify overflows the stack (STUDY-109): in Bun that
// overflow takes ~1.6 s to throw, so each such request cost that much CPU.
import { afterEach, expect, test } from "bun:test";
import { defineSchema, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";
import { STRINGIFY_SAFE_DEPTH, tooDeepToStringify } from "../src/deep-values.ts";
import { Functions, query } from "../src/functions.ts";
import { createServer } from "../src/server.ts";

const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0)) await s();
});

const nested = (n: number) => JSON.parse(`${"[".repeat(n)}1${"]".repeat(n)}`);

test("the walk: up to the bound is fine, past it is too deep, wherever the deep part sits", () => {
  expect(tooDeepToStringify(nested(STRINGIFY_SAFE_DEPTH))).toBe(false);
  expect(tooDeepToStringify(nested(STRINGIFY_SAFE_DEPTH + 1))).toBe(true);
  expect(tooDeepToStringify(nested(100_000))).toBe(true);
  // Wide first, deep last; in an object field too.
  expect(tooDeepToStringify([...Array.from({ length: 1000 }, (_, i) => i), { x: nested(5000) }])).toBe(true);
  for (const plain of [null, 1, "s", { a: [1, 2, { b: 3 }] }, []]) expect(tooDeepToStringify(plain)).toBe(false);
});

test("over HTTP, a 100 000-level argument is refused with the nesting message at once, not after seconds", async () => {
  const engine = await new Engine(defineSchema({}), await MemoryPersistence.open(null, { durable: false })).init();
  const functions = new Functions(engine).register("m", {
    echo: query({ args: { x: v.any() }, handler: async () => 1 }),
  });
  const { server, stop } = createServer({ engine, functions, port: 0, redactLogsToClient: false });
  stops.push(stop);
  const n = 100_000;
  const t0 = performance.now();
  const r = await fetch(`http://127.0.0.1:${server.port}/api/query`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: `{"path":"m:echo","args":{"x":${"[".repeat(n)}1${"]".repeat(n)}}}`,
  });
  const body = (await r.json()) as { status: string; errorMessage: string };
  const ms = performance.now() - t0;
  expect(body.status).toBe("error");
  expect(body.errorMessage).toContain("Invalid arguments for m.js:echo: Value is too nested");
  // A stringify overflow alone takes ~1.6 s.
  expect(ms).toBeLessThan(1000);
});
