// The common-password list and lookup (STUDY-201 §3.4), upstream's `components/password/commonPasswords.test.ts`
// ported.
import { describe, expect, test } from "bun:test";
import { COMMON_PASSWORDS_BY_LENGTH } from "../src/components/password/commonPasswords.generated.ts";
import { isCommonPassword } from "../src/components/password/commonPasswords.ts";
import { MIN_PASSWORD_LENGTH } from "../src/components/password/validation.ts";

const allPasswords = Object.values(COMMON_PASSWORDS_BY_LENGTH).flat();

describe("the generated list", () => {
  test("contains 3000 passwords", () => {
    expect(allPasswords.length).toBe(3000);
  });

  test("contains no password that is too short", () => {
    for (const password of allPasswords) expect([...password].length).toBeGreaterThanOrEqual(MIN_PASSWORD_LENGTH);
  });

  test("contains only lowercase passwords in the NFC form", () => {
    for (const password of allPasswords) expect(password).toBe(password.normalize("NFC").toLowerCase());
  });

  test("groups the passwords by their true length", () => {
    for (const [length, bucket] of Object.entries(COMMON_PASSWORDS_BY_LENGTH))
      for (const password of bucket) expect([...password].length).toBe(Number(length));
  });

  // The binary search in `isCommonPassword` is correct only if each array is in ascending order.
  test("keeps each array in ascending order", () => {
    for (const bucket of Object.values(COMMON_PASSWORDS_BY_LENGTH)) expect(bucket).toEqual([...bucket].sort());
  });

  test("contains no duplicate", () => {
    expect(new Set(allPasswords).size).toBe(allPasswords.length);
  });
});

describe("isCommonPassword", () => {
  test("finds every password of the list", () => {
    for (const password of allPasswords) expect(isCommonPassword(password)).toBe(true);
  });

  test("does not find a password that is not in the list", () => {
    expect(isCommonPassword("correct horse battery staple")).toBe(false);
    expect(isCommonPassword("kY7t-vQ2mZ0x")).toBe(false);
  });

  test("ignores the case", () => {
    expect(isCommonPassword("password123")).toBe(true);
    expect(isCommonPassword("Password123")).toBe(true);
    expect(isCommonPassword("PASSWORD123")).toBe(true);
    expect(isCommonPassword("QwErTyUiOp")).toBe(true);
  });

  // The list holds only ASCII, so a password with a combining accent is in it in no normalization form.
  test("accepts a password in the NFD form", () => {
    const decomposed = "cafécafécafé".normalize("NFD");
    expect(decomposed).not.toBe("cafécafécafé");
    expect(isCommonPassword(decomposed)).toBe(false);
  });

  test("does not find a password that is too short for the list", () => {
    expect(isCommonPassword("password")).toBe(false);
    expect(isCommonPassword("")).toBe(false);
  });
});
