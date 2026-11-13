// The password format's minimum length (STUDY-208 §1.11), upstream's `components/password/validation.test.ts` at v2.0.0,
// ported.
import { describe, expect, test } from "bun:test";
import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  validateNewPassword,
  validatePasswordInputFormat,
} from "../src/components/password/validation.ts";

describe("minimumLength", () => {
  test("rejects a password that is shorter than minimumLength", () => {
    expect(validatePasswordInputFormat("kY7t-vQ2m", 10)).toEqual({ error: "PASSWORD_TOO_SHORT", minimumLength: 10 });
  });

  test("accepts a password that is as long as minimumLength or longer", () => {
    expect(validatePasswordInputFormat("kY7t-vQ2m", 9)).toBe(null);
    expect(validatePasswordInputFormat("kY7t-vQ2m", MIN_PASSWORD_LENGTH)).toBe(null);
  });

  test("accepts a minimumLength of MAX_PASSWORD_LENGTH", () => {
    expect(validatePasswordInputFormat("a".repeat(MAX_PASSWORD_LENGTH), MAX_PASSWORD_LENGTH)).toBe(null);
  });

  test.each([
    ["less than MIN_PASSWORD_LENGTH", MIN_PASSWORD_LENGTH - 1],
    ["0", 0],
    ["more than MAX_PASSWORD_LENGTH", MAX_PASSWORD_LENGTH + 1],
    ["NaN", Number.NaN],
  ])("throws when minimumLength is %s", (_, minimumLength) => {
    expect(() => validatePasswordInputFormat("kY7t-vQ2m", minimumLength)).toThrow(
      `minimumLength must be between 8 and 100, but it is ${minimumLength}.`,
    );
    expect(() => validateNewPassword("kY7t-vQ2m", minimumLength)).toThrow("minimumLength must be between 8 and 100");
  });
});
