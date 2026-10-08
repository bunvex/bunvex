// JSON text as Convex's serde_json writes a job's or a cron's arguments (STUDY-133 §12 M8): `JSON.stringify` but
// for the numbers, which take serde_json's layout (`formatExportFloat`, checked against Rust in float-text.test.ts).
import { expect, test } from "bun:test";
import { jsonText, toJsonValue } from "../src/index.ts";

test("numbers as serde_json writes them; everything else as JSON.stringify", () => {
  expect(jsonText([{ s: "cron", x: 3 }])).toBe('[{"s":"cron","x":3.0}]');
  expect(jsonText({ a: 0, b: -2, c: 0.5, d: 1e16, e: 1e-7, f: 1e15 })).toBe(
    '{"a":0.0,"b":-2.0,"c":0.5,"d":1e+16,"e":1e-7,"f":1000000000000000.0}',
  );
  const tricky = { 'quote"d': 'a "b" \\ \u0000 é 😀', "1": true, nested: [null, false, [], {}] };
  expect(jsonText(tricky)).toBe(JSON.stringify(tricky));
  // A value's special numbers are objects already ($integer, $float), so they print as JSON.stringify does.
  expect(jsonText(toJsonValue([5n, Number.NaN, -0]))).toBe(JSON.stringify(toJsonValue([5n, Number.NaN, -0])));
});
