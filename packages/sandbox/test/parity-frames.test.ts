import { expect, test } from "bun:test";
import { constructedAt } from "./parity-frames.ts";

const stack = (top: number, below: number) =>
  `Uncaught Error: deep\n    at f (cases.js:173:${top})\n    at f (cases.js:173:${below})`;

test("the constructing frame's column is not compared; the rest of the stack is", () => {
  expect(constructedAt(stack(66, 93))).toBe(constructedAt(stack(75, 93)));
  expect(constructedAt(stack(66, 93))).not.toBe(constructedAt(stack(66, 94)));
  expect(constructedAt(stack(66, 93))).toBe(
    "Uncaught Error: deep\n    at f (cases.js:173:<col>)\n    at f (cases.js:173:93)",
  );
});

test("in a JSON-encoded log line too, and for any error class", () => {
  const line = (top: number) =>
    JSON.stringify([`TypeError: x\n    at handler (lib.js:10:${top})\n    at y (lib.js:3:1)`]);
  expect(constructedAt(line(70))).toBe(constructedAt(line(79)));
  expect(constructedAt(line(70))).toContain("lib.js:3:1");
});
