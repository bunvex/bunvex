// Convex's identifiers and Rust's display of a character (STUDY-161 §1), as the backend's binary words them.
import { expect, test } from "bun:test";
import { identifierError, rustDebugChar } from "../src/index.ts";

test("each rule in Convex's order and words", () => {
  expect(identifierError("messages")).toBeNull();
  expect(identifierError("_x9")).toBeNull();
  expect(identifierError("a".repeat(64))).toBeNull();
  expect(identifierError("")).toBe("Identifier cannot be empty");
  expect(identifierError("9lives")).toBe(
    "Invalid first character '9' in 9lives: Identifiers must start with an alphabetic character or underscore",
  );
  expect(identifierError("a-b")).toBe(
    "Identifier a-b has invalid character '-': Identifiers can only contain alphanumeric characters or underscores",
  );
  expect(identifierError("a".repeat(65))).toBe("Identifier is too long (65 > maximum 64)");
  expect(identifierError("__")).toBe("Identifier __ cannot have exclusively underscores");
  // the characters before the length: a long name with a bad character names the character
  expect(identifierError(`${"a".repeat(70)}-`)).toContain("has invalid character '-'");
});

test("a character as Rust's `{:?}`: named escapes, `\\u{…}` for what Rust does not print, the rest as is", () => {
  // each checked against Convex's backend (`db.insert` of `a<c>b`)
  const cases: [string, string][] = [
    ["\n", "'\\n'"],
    ["\t", "'\\t'"],
    ["\r", "'\\r'"],
    ["\0", "'\\0'"],
    ["'", "'\\''"],
    ['"', "'\"'"],
    ["\\", "'\\\\'"],
    [" ", "' '"],
    ["\u0001", "'\\u{1}'"],
    ["\u007f", "'\\u{7f}'"],
    [" ", "'\\u{a0}'"],
    ["­", "'\\u{ad}'"],
    ["​", "'\\u{200b}'"],
    [" ", "'\\u{2028}'"],
    ["́", "'\\u{301}'"],
    ["é", "'é'"],
    ["😀", "'😀'"],
  ];
  for (const [c, shown] of cases) expect([c, rustDebugChar(c)]).toEqual([c, shown]);
});
