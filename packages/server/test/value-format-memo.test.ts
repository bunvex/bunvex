// `reformat` keeps its latest rewrites (a cached query hands every caller the same text): a kept rewrite is
// exactly what a fresh one gives, per format, and the memo stays within its bounds.
import { expect, test } from "bun:test";
import { fromJsonValue, toJsonValue, type Value } from "@bunvex/values";
import { writeValue } from "../src/streaming-export.ts";
import { reformat, reformatMemoStats } from "../src/value-format.ts";

const encoded = (v: Value) => JSON.stringify(toJsonValue(v));
const fresh = (json: string, f: "clean" | "export") => writeValue(fromJsonValue(JSON.parse(json)), f);

test("a kept rewrite is a fresh one, and formats never share one", () => {
  const values: Value[] = [{ b: 1.5, a: 10n, c: [1, -0, 1e21] }, [null, "x", true], { z: { y: 0.1 } }];
  for (let round = 0; round < 3; round++)
    for (const v of values) {
      const json = encoded(v);
      expect(reformat(json, "clean")).toBe(fresh(json, "clean"));
      expect(reformat(json, "export")).toBe(fresh(json, "export"));
      expect(reformat(json, "encoded")).toBe(json);
    }
  const json = encoded({ n: 10n });
  expect(reformat(json, "clean")).toBe('{"n":"10"}');
  expect(reformat(json, "export")).toBe('{"n":10}');
});

test("the memo keeps at most 1024 rewrites per format, and none over 1 MiB", () => {
  for (let i = 0; i < 3000; i++) reformat(encoded({ i, pad: "x".repeat(i % 50) }), "clean");
  expect(reformatMemoStats().clean!.entries).toBe(1024);
  const before = reformatMemoStats().clean!;
  const big = encoded({ big: "y".repeat(1024 * 1024) });
  expect(reformat(big, "clean")).toBe(fresh(big, "clean"));
  expect(reformatMemoStats().clean).toEqual(before);
});
