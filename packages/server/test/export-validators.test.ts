// `exportArgs()` / `exportReturns()` (STUDY-105): every registered function carries its validators' JSON as
// Convex's do (registration_impl.ts), the push's analysis reads them with Convex's checks and messages
// (analyze.rs `parse_args_validator` / `parse_returns_validator`), and `apiSpec` reports what they give.
import { describe, expect, test } from "bun:test";
import { defineSchema, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";
import { CodeVersion, FunctionExportError, InvalidModulesError, type ModuleSource } from "../src/code-version.ts";
import {
  action,
  Functions,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "../src/functions.ts";

type Exports = { exportArgs(): string; exportReturns(): string };
const exportsOf = (f: unknown) => f as Exports;

describe("the builders", () => {
  test("every registered function has both methods as plain own properties", () => {
    for (const builder of [query, internalQuery, mutation, internalMutation, action, internalAction]) {
      const f = (builder as (d: unknown) => unknown)({ handler: async () => null });
      for (const m of ["exportArgs", "exportReturns"]) {
        const d = Object.getOwnPropertyDescriptor(f, m);
        expect(typeof d?.value).toBe("function");
        expect(d).toMatchObject({ writable: true, enumerable: true, configurable: true });
      }
    }
  });

  test("without validators: any arguments, a null result validator", () => {
    const bare = exportsOf(query(async () => 1));
    expect(bare.exportArgs()).toBe('{"type":"any"}');
    expect(bare.exportReturns()).toBe("null");
    const noReturns = exportsOf(mutation({ args: {}, handler: async () => {} }));
    expect(noReturns.exportReturns()).toBe("null");
  });

  test("an object of fields is v.object of them, for args and returns; a validator is its JSON", () => {
    const f = exportsOf(
      action({
        args: { n: v.int64(), s: v.optional(v.string()) },
        returns: { ok: v.boolean() },
        handler: async () => ({ ok: true }),
      }),
    );
    expect(f.exportArgs()).toBe(JSON.stringify(v.object({ n: v.int64(), s: v.optional(v.string()) }).json));
    expect(JSON.parse(f.exportArgs())).toEqual({
      type: "object",
      value: {
        n: { fieldType: { type: "bigint" }, optional: false },
        s: { fieldType: { type: "string" }, optional: true },
      },
    });
    expect(f.exportReturns()).toBe(
      '{"type":"object","value":{"ok":{"fieldType":{"type":"boolean"},"optional":false}}}',
    );
    const g = exportsOf(
      internalQuery({ args: v.object({}), returns: v.array(v.literal(1n)), handler: async () => [] }),
    );
    expect(g.exportArgs()).toBe('{"type":"object","value":{}}');
    expect(g.exportReturns()).toBe('{"type":"array","value":{"type":"literal","value":{"$integer":"AQAAAAAAAAA="}}}');
  });
});

const load = (modules: ModuleSource[]) =>
  CodeVersion.load(modules, { seed: Uint32Array.of(1, 2, 3, 4), timestamp: 1_700_000_000_000 });
const fnModule = (body: string): ModuleSource => ({
  path: "m.js",
  source: `import { query } from "@bunvex/server"; import { v } from "@bunvex/values";\n${body}`,
  environment: "isolate",
});
/** The push's error: InvalidModules' message (its header dropped), or the class and message of another. */
const failure = (p: Promise<unknown>) =>
  p.then(
    () => "loaded",
    (e) =>
      e instanceof InvalidModulesError
        ? e.message.split("\n").slice(1).join("\n")
        : `${(e as Error).constructor.name}: ${(e as Error).message.split("\n")[0]}`,
  );

describe("the analysis", () => {
  test("stores what the methods give: any arguments and a null result validator by default", async () => {
    const version = await load([
      fnModule(
        `export const bare = query(async () => 1);
         export const typed = query({ args: { n: v.number() }, returns: v.string(), handler: async () => "" });`,
      ),
    ]);
    const fns = Object.fromEntries(version.analysis["m.js"]!.functions.map((f) => [f.name, [f.args, f.returns]]));
    expect(fns.bare).toEqual(['{"type":"any"}', "null"]);
    expect(fns.typed).toEqual([
      '{"type":"object","value":{"n":{"fieldType":{"type":"number"},"optional":false}}}',
      '{"type":"string"}',
    ]);
  });

  test("an export without the methods is unvalidated, as Convex treats one from before them", async () => {
    const version = await load([
      fnModule(`export const q = query(async () => 1); delete q.exportArgs; delete q.exportReturns;`),
    ]);
    const f = version.analysis["m.js"]!.functions[0]!;
    expect([f.args, f.returns]).toEqual(['{"type":"any"}', "null"]);
  });

  test("a broken export fails the push with Convex's messages", async () => {
    const broken = (patch: string) => failure(load([fnModule(`export const q = query(async () => 1); ${patch}`)]));
    expect(await broken("q.exportArgs = 5;")).toBe("m.js:q.exportArgs is not a function or `undefined`.");
    expect(await broken("q.exportReturns = null;")).toBe("m.js:q.exportReturns is not a function or `undefined`.");
    expect(await broken("q.exportArgs = () => 1;")).toBe(
      "Invalid exportArgs return value: m.js:q.exportArgs() didn't return a string.",
    );
    expect(await broken("q.exportReturns = () => ({});")).toBe(
      "Invalid exportReturns return value: m.js:q.exportReturns() didn't return a string.",
    );
    expect(await broken('q.exportArgs = () => "{";')).toStartWith("Invalid JSON returned from m.js:q.exportArgs(): ");
    expect(await broken('q.exportReturns = () => "nope";')).toStartWith(
      "Invalid JSON returned from m.js:q.exportReturns(): ",
    );
    expect(await broken(`q.exportArgs = () => '{"type":"string"}';`)).toBe(
      "Invalid JSON returned from m.js:q.exportArgs(): Args validator must be an object or any",
    );
    // Convex rejects a non-object `args` validator at push.
    expect(
      await failure(load([fnModule(`export const q = query({ args: v.string(), handler: async () => 1 });`)])),
    ).toBe("Invalid JSON returned from m.js:q.exportArgs(): Args validator must be an object or any");
  });

  test("a method that throws fails the push with its error, as Convex's `Error`", async () => {
    const r = await load([
      fnModule(`export const q = query(async () => 1); q.exportArgs = () => { throw new Error("boom"); };`),
    ]).catch((e) => e);
    expect(r).toBeInstanceOf(FunctionExportError);
    expect(r).toMatchObject({ status: 400, code: "Error" });
    expect((r as Error).message.split("\n")[0]).toBe("Uncaught Error: boom");
  });

  test("a validator still undefined when the JSON is made: Convex's strict replacer, without the docs link", () => {
    // A validator whose JSON holds a field's validator that was not defined yet (a circular import).
    const json = { type: "object", value: { a: { fieldType: undefined, optional: false } } };
    const g = exportsOf(query({ returns: { isValidator: true, json }, handler: async () => "" } as never));
    expect(() => g.exportReturns()).toThrow(
      'A validator is undefined for field "fieldType". This is often caused by circular imports.',
    );
    expect(() => g.exportReturns()).not.toThrow(/https?:/);
  });
});

describe("apiSpec", () => {
  test("reports what the methods give: a null result validator for a function without one", async () => {
    const engine = await new Engine(defineSchema({}), await MemoryPersistence.open(null, { durable: false })).init();
    const functions = new Functions(engine).register("m", {
      bare: internalMutation(async () => {}),
      typed: query({ args: { n: v.number() }, returns: v.null(), handler: async () => null }),
    });
    expect(functions.apiSpec()).toEqual([
      {
        identifier: "m.js:bare",
        functionType: "Mutation",
        visibility: { kind: "internal" },
        args: { type: "any" },
        returns: null,
      },
      {
        identifier: "m.js:typed",
        functionType: "Query",
        visibility: { kind: "public" },
        args: { type: "object", value: { n: { fieldType: { type: "number" }, optional: false } } },
        returns: { type: "null" },
      },
    ]);
  });
});
