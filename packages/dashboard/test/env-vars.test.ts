import { describe, expect, test } from "bun:test";
import {
  formatDotenv,
  nameProblem,
  parseDotenv,
  setProblem,
  valueProblem,
  valueWarning,
} from "../src/settings/env-vars.ts";

describe("environment variable rules", () => {
  test("names: a letter or underscore first, then letters, digits, underscores; at most 256", () => {
    for (const ok of ["A", "_x", "API_KEY_2", "a".repeat(256)]) expect(nameProblem(ok)).toBeUndefined();
    expect(nameProblem("")).toBe("A name is required.");
    for (const bad of ["1A", "A-B", "A B", "É"]) expect(nameProblem(bad)).toMatch(/letters, digits/);
    expect(nameProblem("a".repeat(257))).toMatch(/256/);
  });

  test("values at most 8 KiB; the set at most 512 variables and 512 KiB", () => {
    expect(valueProblem("x".repeat(8192))).toBeUndefined();
    expect(valueProblem("x".repeat(8193))).toMatch(/8 KiB/);
    expect(valueProblem("é".repeat(4097))).toMatch(/8 KiB/); // bytes, not characters
    const many = Array.from({ length: 513 }, (_, i) => ({ name: `V${i}`, value: "" }));
    expect(setProblem(many)).toMatch(/512 environment variables/);
    const big = Array.from({ length: 65 }, (_, i) => ({ name: `V${i}`, value: "x".repeat(8100) }));
    expect(setProblem(big)).toMatch(/512 KiB/);
  });

  test("warnings for quotes and spaces", () => {
    expect(valueWarning('"x"')).toMatch(/quotes/);
    expect(valueWarning(" x")).toMatch(/spaces/);
    expect(valueWarning("x")).toBeUndefined();
  });

  test(".env files: comments, export, quotes, escapes; not a .env file is null", () => {
    expect(
      parseDotenv('# a comment\nexport A=1\nB = "two words"\nC=\'single\'\nD="line\\nbreak"\nE=plain # trailing\n\n'),
    ).toEqual([
      { name: "A", value: "1" },
      { name: "B", value: "two words" },
      { name: "C", value: "single" },
      { name: "D", value: "line\nbreak" },
      { name: "E", value: "plain" },
    ]);
    expect(parseDotenv("JUST_A_NAME")).toBeNull();
    expect(
      formatDotenv([
        { name: "A", value: "x y" },
        { name: "B", value: "https://a.b/c" },
      ]),
    ).toBe('A="x y"\nB=https://a.b/c');
  });
});
