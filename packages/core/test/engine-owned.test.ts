// The test runs freeze the engine's own values (test/preload.ts): a staged version cannot be changed, so a
// path handing one to a function instead of a copy fails its test at the mutation.
import { expect, test } from "bun:test";
import { engineOwned, FREEZE_ENGINE_VALUES } from "../src/engine-owned.ts";

test("the test runs freeze the engine's values, deeply; bytes are left as they are", () => {
  expect(FREEZE_ENGINE_VALUES).toBe(true);
  const bytes = new ArrayBuffer(4);
  const v = engineOwned({ a: { b: [1, { c: 2 }] }, bytes });
  expect(() => {
    (v.a.b[1] as { c: number }).c = 3;
  }).toThrow(TypeError);
  expect(() => {
    (v.a.b as unknown[]).push(4);
  }).toThrow(TypeError);
  new Uint8Array(bytes)[0] = 7; // a buffer's contents cannot be frozen: still writable
  expect(new Uint8Array(v.bytes)[0]).toBe(7);
});
