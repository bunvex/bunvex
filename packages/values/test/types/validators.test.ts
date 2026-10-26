// The validator builders' types (STUDY-189 T6), with Convex's cases from its `values/validator.test.ts`: checked
// by `tsc` (`bun run typecheck`); each `Equal` must hold and each `@ts-expect-error` must be an error. The tests
// run what does not throw, and the record cases that the runtime also refuses.
import { expect, test } from "bun:test";
import { type GenericId, type Infer, v } from "../../src/index.ts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const check = <T extends true>(_: T) => {};

const optional = v.optional(v.string());
const required = v.string();

test("a record's keys and values, a union's members and an array's element are never optional", () => {
  v.object({ optional });

  v.array(required);
  // @ts-expect-error an optional element
  v.array(optional);

  v.record(required, required);
  // @ts-expect-error an optional value
  expect(() => v.record(required, optional)).toThrow("Record validator cannot have optional values");
  // @ts-expect-error an optional key
  expect(() => v.record(optional, required)).toThrow("Record validator cannot have optional keys");
  // @ts-expect-error an optional key and value
  expect(() => v.record(optional, optional)).toThrow("Record validator cannot have optional keys");

  v.union(required, required);
  // @ts-expect-error optional members
  v.union(optional, optional);
  // @ts-expect-error an optional member
  v.union(required, optional);
  // @ts-expect-error an optional member
  v.union(optional, required);
  // @ts-expect-error `v.nullable` is a union, so the same holds
  v.nullable(optional);
});

test("a record's keys are strings", () => {
  const ids = v.record(v.id("table1"), v.string());
  check<Equal<Infer<typeof ids>, Record<GenericId<"table1">, string>>>(true);
  const unionOfIds = v.record(v.union(v.id("table1"), v.id("table2")), v.string());
  check<Equal<Infer<typeof unionOfIds>, Record<GenericId<"table1"> | GenericId<"table2">, string>>>(true);
  const strings = v.record(v.string(), v.number());
  check<Equal<Infer<typeof strings>, Record<string, number>>>(true);

  // @ts-expect-error a number key
  v.record(v.number(), v.string());
  // @ts-expect-error an int64 key
  v.record(v.int64(), v.string());
  // @ts-expect-error a float64 key
  v.record(v.float64(), v.string());
  // @ts-expect-error a null key
  v.record(v.null(), v.string());
  // @ts-expect-error a boolean key
  v.record(v.boolean(), v.string());
  // @ts-expect-error a number literal key
  v.record(v.literal(1), v.string());

  // These compile, and a push refuses them (as on Convex).
  const literals = v.record(v.union(v.literal("abc"), v.literal("def")), v.string());
  check<Equal<Infer<typeof literals>, Record<"abc" | "def", string>>>(true);
  v.record(v.union(v.id("table1"), v.literal("def")), v.string());
});

test("complex types look good", () => {
  const obj = v.object({
    a: v.record(v.string(), v.string()),
    b: v.string(),
    c: v.union(v.string(), v.union(v.string(), v.number())),
    d: v.object({ foo: v.string(), bar: v.optional(v.number()) }),
  });
  check<
    Equal<
      Infer<typeof obj>,
      { a: Record<string, string>; b: string; c: string | number; d: { bar?: number | undefined; foo: string } }
    >
  >(true);
  expect(obj.kind).toBe("object");
});
