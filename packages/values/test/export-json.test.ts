// The snapshot export's encoding (STUDY-42): Convex's clean lossless JSON — int64 as integers, float64
// always as floats in ryu's shortest form, `$float` / `$bytes`, keys in byte order — and its decoding.
import { expect, test } from "bun:test";
import { formatExportFloat, fromExportJson, toExportJson } from "../src/export-json.ts";

test("floats as serde_json writes them (Convex's 1.0.151: a positive exponent has a `+`)", () => {
  const cases: [number, string][] = [
    [0, "0.0"],
    [-0, "-0.0"],
    [1, "1.0"],
    [123, "123.0"],
    [0.1, "0.1"],
    [-2.5, "-2.5"],
    [1e15, "1000000000000000.0"],
    [1e16, "1e+16"],
    [12345678901234568, "1.2345678901234568e+16"],
    [1e21, "1e+21"],
    [0.00001, "0.00001"],
    [1e-6, "1e-6"],
    [1.5e-7, "1.5e-7"],
    [1.7976931348623157e308, "1.7976931348623157e+308"],
    [5e-324, "5e-324"],
    [1790964624820.0051, "1790964624820.0051"],
  ];
  for (const [n, s] of cases) expect([n, formatExportFloat(n)]).toEqual([n, s]);
});

test("values: int64 vs float64, special floats, bytes, keys in byte order; and back", () => {
  const v = {
    z: 1n,
    a: { y: [1, -1n], x: null },
    B: true,
    _id: "id",
    nan: Number.NaN,
    inf: Number.NEGATIVE_INFINITY,
    bytes: new Uint8Array([255, 0]).buffer,
    s: 'quote " and é',
  };
  const text = toExportJson(v);
  expect(text).toBe(
    '{"B":true,"_id":"id","a":{"x":null,"y":[1.0,-1]},"bytes":{"$bytes":"/wA="},"inf":{"$float":"AAAAAAAA8P8="},"nan":{"$float":"AAAAAAAA+H8="},"s":"quote \\" and é","z":1}',
  );
  const back = fromExportJson(text) as Record<string, unknown>;
  expect(back.z).toBe(1n);
  expect((back.a as { y: unknown[] }).y).toEqual([1, -1n]);
  expect(Number.isNaN(back.nan)).toBe(true);
  expect(back.inf).toBe(Number.NEGATIVE_INFINITY);
  expect(new Uint8Array(back.bytes as ArrayBuffer)).toEqual(new Uint8Array([255, 0]));
  expect(back.s).toBe('quote " and é');
  // A string that looks like a number stays a string.
  expect(fromExportJson('{"n":"12","m":-0.0}')).toEqual({ n: "12", m: -0 });
});
