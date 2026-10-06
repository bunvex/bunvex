// Floats as Convex prints them (STUDY-18 §8), checked against Rust itself: `fixtures/float-text.tsv` holds, for
// 2 500 doubles (edge cases, powers of ten and their neighbours, random bit patterns, the 1e-5..1e-4 band), the
// bits, Rust's `{:?}` and serde_json 1.0.151's text (Convex's lockfile), as `fixtures/float-reference.rs`
// printed them. The same program agreed on 2 000 000 generated doubles when this was written.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { displayValue } from "../src/check.ts";
import { formatExportFloat } from "../src/export-json.ts";
import { floatDebugText } from "../src/float-text.ts";

const view = new DataView(new ArrayBuffer(8));
const fromBits = (hex: string) => {
  view.setBigUint64(0, BigInt(`0x${hex}`));
  return view.getFloat64(0);
};
const rows = readFileSync(join(import.meta.dir, "fixtures/float-text.tsv"), "utf8")
  .trimEnd()
  .split("\n")
  .map((l) => l.split("\t") as [string, string, string]);

test("Rust's {:?} for every fixture double", () => {
  expect(rows.length).toBe(2500);
  const bad = rows.filter(([bits, debug]) => floatDebugText(fromBits(bits)) !== debug);
  expect(bad).toEqual([]);
});

test("serde_json's text for every finite fixture double", () => {
  const bad = rows.filter(([bits, , json]) => json !== "" && formatExportFloat(fromBits(bits)) !== json);
  expect(bad).toEqual([]);
});

test("the layout: decimal for 1e-4 <= |x| < 1e16, else scientific; specials", () => {
  const cases: [number, string][] = [
    [0, "0.0"],
    [-0, "-0.0"],
    [1, "1.0"],
    [0.1, "0.1"],
    [1e15, "1000000000000000.0"],
    [9999999999999998, "9999999999999998.0"],
    [1e16, "1e16"],
    [1.5e16, "1.5e16"],
    [1e21, "1e21"],
    [0.0001, "0.0001"],
    [5e-5, "5e-5"],
    [1.5e-7, "1.5e-7"],
    [5e-324, "5e-324"],
    [1.7976931348623157e308, "1.7976931348623157e308"],
    [Number.NaN, "NaN"],
    [Number.POSITIVE_INFINITY, "inf"],
    [Number.NEGATIVE_INFINITY, "-inf"],
  ];
  for (const [x, text] of cases) expect([x, floatDebugText(x)]).toEqual([x, text]);
  // The values in messages use it, nested too.
  expect(displayValue([1e16, { a: 5e-5 }, -2])).toBe("[1e16, {a: 5e-5}, -2.0]");
});

test("an exact tie between two shortest candidates: Rust takes the upper one, JavaScript the even one", () => {
  // From the reference: `toExponential` gives …62 / …2; Rust prints …63 / …3.
  const ties: [string, string][] = [
    ["c2716d8e4ea37e80", "-1197639789111.9063"],
    ["4310397d1ffa8ad9", "1141702299394742.3"],
    ["42b32dc91d2bf890", "21087368588280.563"],
    ["c2e3e6316fb01f94", "-175035142471932.63"],
  ];
  for (const [bits, rust] of ties) {
    const x = fromBits(bits);
    expect(String(x)).not.toBe(rust);
    expect(floatDebugText(x)).toBe(rust);
    expect(Number(rust)).toBe(x);
  }
});
