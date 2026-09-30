import { describe, expect, test } from "bun:test";
import { checkValue, displayValidator } from "../src/check.ts";
import { encodeId } from "../src/id.ts";
import { type Infer, v } from "../src/validators.ts";

const ok = (x: Parameters<typeof checkValue>[0], value: unknown) => expect(checkValue(x, value as never)).toBeNull();
const err = (x: Parameters<typeof checkValue>[0], value: unknown) => checkValue(x, value as never);

describe("v.* builders and checking (STUDY-13)", () => {
  test("scalars accept their type and refuse others with Convex's message shape", () => {
    ok(v.string(), "s");
    ok(v.number(), 1.5);
    ok(v.float64(), Number.NaN);
    ok(v.int64(), 5n);
    ok(v.bigint(), -5n);
    ok(v.boolean(), false);
    ok(v.null(), null);
    ok(v.bytes(), new ArrayBuffer(2));
    ok(v.any(), { anything: [1n] });
    expect(err(v.string(), 1)).toBe("Value does not match validator.\n\nValue: 1.0\nValidator: v.string()");
    expect(err(v.number(), 1n)).toBe("Value does not match validator.\n\nValue: 1\nValidator: v.float64()");
    expect(err(v.int64(), 1)).toContain("Validator: v.int64()");
    expect(err(v.null(), undefined)).toContain("Value: undefined");
  });

  test("literals compare by type and value", () => {
    ok(v.literal("a"), "a");
    ok(v.literal(3n), 3n);
    expect(err(v.literal(3n), 3)).toBe("`3.0` does not match literal validator `v.literal(3)`.");
    expect(err(v.literal("a"), "b")).toBe('`"b"` does not match literal validator `v.literal("a")`.');
  });

  test("objects: required, optional and extra fields; nested paths", () => {
    const user = v.object({ name: v.string(), age: v.optional(v.number()), tags: v.array(v.string()) });
    ok(user, { name: "ada", tags: [] });
    ok(user, { name: "ada", age: 3, tags: ["x"] });
    ok(user, { name: "ada", age: undefined, tags: [] }); // undefined = absent
    expect(err(user, { tags: [] })).toBe(
      "Object is missing the required field `name`. Consider wrapping the field validator in `v.optional(...)` if this is expected.\n\nObject: {tags: []}\nValidator: v.object({age: v.optional(v.float64()), name: v.string(), tags: v.array(v.string())})",
    );
    expect(err(user, { name: "a", tags: [], extra: 1 })).toContain(
      "Object contains extra field `extra` that is not in the validator.",
    );
    expect(err(user, { name: "a", tags: ["x", 2] })).toBe(
      "Value does not match validator.\nPath: .tags[1]\nValue: 2.0\nValidator: v.string()",
    );
    const deep = v.object({ a: v.object({ b: v.array(v.object({ c: v.int64() })) }) });
    expect(err(deep, { a: { b: [{ c: 1n }, { c: "x" }] } })).toContain("Path: .a.b[1].c");
  });

  test("records check keys and values, with .keys() / .values() paths", () => {
    const r = v.record(v.string(), v.number());
    ok(r, { a: 1, b: 2 });
    expect(err(r, { a: "x" })).toContain("Path: .values()");
    const ids = v.record(v.id("users"), v.boolean());
    expect(err(ids, { notAnId: true })).toContain("Path: .keys()");
    expect(() => v.record(v.string(), v.optional(v.number()))).toThrow("Record validator cannot have optional values");
    expect(() => v.record(v.optional(v.string()), v.number())).toThrow("Record validator cannot have optional keys");
    expect(() => v.record(undefined as never, v.number())).toThrow('A validator is undefined for field "key"');
  });

  test("unions match any member; nullable is union with null", () => {
    const u = v.union(v.string(), v.number());
    ok(u, "a");
    ok(u, 1);
    expect(err(u, true)).toBe(
      "Value does not match validator.\n\nValue: true\nValidator: v.union(v.string(), v.float64())",
    );
    ok(v.nullable(v.string()), null);
    expect(v.nullable(v.string()).kind).toBe("union");
    // A single member reports its own error.
    expect(err(v.union(v.object({ a: v.string() })), { a: 1 })).toContain("Path: .a");
  });

  test("v.id checks that the id names the validator's table", () => {
    const tables: Record<number, string> = { 10001: "users", 10002: "posts", 513: "_tables" };
    const of = (n: number) => tables[n];
    const user = encodeId(10001, new Uint8Array(16));
    const post = encodeId(10002, new Uint8Array(16));
    expect(checkValue(v.id("users"), user, of)).toBeNull();
    expect(checkValue(v.id("users"), post, of)).toBe(
      `Found ID "${post}" from table \`posts\`, which does not match the table name in validator \`v.id("users")\`.`,
    );
    expect(checkValue(v.id("users"), encodeId(513, new Uint8Array(16)), of)).toContain("from a system table");
    expect(checkValue(v.id("users"), "not-an-id", of)).toContain("Value does not match validator.");
    expect(checkValue(v.id("users"), encodeId(10999, new Uint8Array(16)), of)).toContain(
      "Value does not match validator.",
    );
  });

  test("json forms match Convex's", () => {
    expect(v.object({ a: v.optional(v.id("t")), b: v.array(v.bigint()) }).json).toEqual({
      type: "object",
      value: {
        a: { fieldType: { type: "id", tableName: "t" }, optional: true },
        b: { fieldType: { type: "array", value: { type: "bigint" } }, optional: false },
      },
    });
    expect(v.record(v.string(), v.number()).json).toEqual({
      type: "record",
      keys: { type: "string" },
      values: { fieldType: { type: "number" }, optional: false },
    });
    expect(v.literal(2n).json).toEqual({ type: "literal", value: { $integer: "AgAAAAAAAAA=" } });
    expect(v.union(v.null(), v.boolean()).json).toEqual({
      type: "union",
      value: [{ type: "null" }, { type: "boolean" }],
    });
    expect(v.number().kind).toBe("float64");
    expect(v.string().optional().isOptional).toBe("optional");
  });

  test("object helpers: omit, pick, partial, extend", () => {
    const o = v.object({ a: v.string(), b: v.number(), c: v.boolean() });
    expect(Object.keys(o.omit("b").fields)).toEqual(["a", "c"]);
    expect(Object.keys(o.pick("b").fields)).toEqual(["b"]);
    expect(checkValue(o.partial(), {})).toBeNull();
    expect(displayValidator(o.extend({ d: v.null() }))).toBe(
      "v.object({a: v.string(), b: v.float64(), c: v.boolean(), d: v.null()})",
    );
  });

  test("Infer gives the TypeScript type (checked by tsc)", () => {
    const task = v.object({
      title: v.string(),
      done: v.boolean(),
      n: v.optional(v.int64()),
      tag: v.union(v.literal("a"), v.null()),
    });
    type Task = Infer<typeof task>;
    const t: Task = { title: "x", done: false, tag: null };
    const t2: Task = { title: "x", done: true, n: 3n, tag: "a" };
    // @ts-expect-error — `done` is required
    const bad: Task = { title: "x", tag: null };
    expect([t, t2, bad].length).toBe(3);
  });
});
