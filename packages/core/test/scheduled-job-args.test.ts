// A scheduled job's argument bytes are serde_json's text, as Convex writes them (STUDY-133 §12 M8).
import { expect, test } from "bun:test";
import { argsToBytes } from "../src/scheduled-jobs.ts";

test("a scheduled job's arguments, as bytes, are Convex's text", () => {
  expect(new TextDecoder().decode(argsToBytes([{ n: 2, s: "x" }]))).toBe('[{"n":2.0,"s":"x"}]');
});
