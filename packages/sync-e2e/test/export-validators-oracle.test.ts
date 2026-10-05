// `exportArgs()` / `exportReturns()` against the official package (STUDY-105): the same definitions, made with
// each package's own builders and validators, give the same strings, and both methods are own properties.
import { describe, expect, test } from "bun:test";
import { action, internalAction, internalMutation, internalQuery, mutation, query } from "@bunvex/server";
import { v as bv } from "@bunvex/values";
import {
  actionGeneric,
  internalActionGeneric,
  internalMutationGeneric,
  internalQueryGeneric,
  mutationGeneric,
  queryGeneric,
} from "convex/server";
import { v as cv } from "convex/values";

type Exports = { exportArgs(): string; exportReturns(): string };
// biome-ignore lint/suspicious/noExplicitAny: one definition for both packages' builders and validators
type V = any;

/** The definitions, each written once over a package's `v`. */
const definitions = (v: V): Record<string, unknown>[] => [
  { handler: async () => null },
  { args: {}, handler: async () => null },
  { args: { n: v.number(), s: v.optional(v.string()) }, handler: async () => null },
  { args: v.object({ id: v.id("items") }), returns: v.null(), handler: async () => null },
  { args: v.any(), returns: { ok: v.boolean(), n: v.optional(v.int64()) }, handler: async () => null },
  {
    returns: v.union(v.literal("a"), v.literal(1n), v.array(v.bytes()), v.record(v.string(), v.float64())),
    handler: async () => null,
  },
];

const BUILDERS = [
  ["query", query, queryGeneric],
  ["internalQuery", internalQuery, internalQueryGeneric],
  ["mutation", mutation, mutationGeneric],
  ["internalMutation", internalMutation, internalMutationGeneric],
  ["action", action, actionGeneric],
  ["internalAction", internalAction, internalActionGeneric],
] as const;

describe("exportArgs / exportReturns, as the official package's", () => {
  for (const [name, ours, theirs] of BUILDERS)
    test(name, () => {
      const [b, c] = [definitions(bv), definitions(cv)];
      for (let i = 0; i < b.length; i++) {
        const mine = (ours as unknown as (d: unknown) => Exports)(b[i]);
        const oracle = (theirs as unknown as (d: unknown) => Exports)(c[i]);
        expect([mine.exportArgs(), mine.exportReturns()]).toEqual([oracle.exportArgs(), oracle.exportReturns()]);
        for (const m of ["exportArgs", "exportReturns"] as const)
          expect(Object.hasOwn(mine, m)).toBe(Object.hasOwn(oracle, m));
      }
    });
});
