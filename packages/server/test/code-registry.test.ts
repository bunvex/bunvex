// The code a call resolves against, one version at a time (STUDY-194 §10.5, 2b commit 0c): a version is published
// whole, with its own epoch, and calls see the code before a change or after it, never part of one.
import { expect, test } from "bun:test";
import { defineSchema, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import type { FunctionDef } from "../src/functions.ts";
import { Functions, query } from "../src/functions.ts";

const said = (word: string) => query({ args: {}, handler: () => word });

async function setup() {
  const engine = await new Engine(defineSchema({}), await MemoryPersistence.open(null, { durable: false })).init();
  return { engine, fns: new Functions(engine) };
}

test("a swap publishes its changes as one version: calls during it see the version before", async () => {
  const { fns } = await setup();
  fns.register("a", { hi: said("a1") }).register("b", { hi: said("b1") });
  const before = fns.codeEpoch;
  const seen: unknown[] = [];
  fns.swap(() => {
    fns.install(new Map<string, FunctionDef>([["a:hi", said("a2")]]), new Map([["a", "h2"]]));
    seen.push(fns.functionPaths());
    fns.register("b", { hi: said("b2") });
    seen.push(fns.functionPaths());
  });
  // Inside the swap, the code before it: both of the registered modules, as they were.
  expect(seen).toEqual([
    ["a.js:hi", "b.js:hi"],
    ["a.js:hi", "b.js:hi"],
  ]);
  expect(fns.codeEpoch).toBe(before + 1);
  expect(fns.functionPaths()).toEqual(["a.js:hi", "b.js:hi"]);
  expect(await fns.runQuery("a:hi", {})).toBe("a2");
  expect(await fns.runQuery("b:hi", {})).toBe("b2");
});

test("a change outside a swap is a version of its own; a failed swap publishes nothing", async () => {
  const { fns } = await setup();
  const e0 = fns.codeEpoch;
  fns.register("a", { hi: said("a1") });
  expect(fns.codeEpoch).toBe(e0 + 1);
  expect(() =>
    fns.swap(() => {
      fns.register("a", { hi: said("lost") });
      throw new Error("load failed");
    }),
  ).toThrow("load failed");
  expect(fns.codeEpoch).toBe(e0 + 1);
  expect(await fns.runQuery("a:hi", {})).toBe("a1");
});
