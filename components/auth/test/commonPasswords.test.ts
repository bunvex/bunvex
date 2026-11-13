// The common-password list and lookup (STUDY-201 §3.4, STUDY-208 §1.11), upstream's
// `components/password/commonPasswords.test.ts` at v2.0.0 ported.
import { describe, expect, test } from "bun:test";
import { COMMON_PASSWORDS_BY_LENGTH } from "../src/components/password/commonPasswords.generated.ts";
import { isCommonPassword } from "../src/components/password/commonPasswords.ts";
import { MIN_PASSWORD_LENGTH } from "../src/components/password/validation.ts";
import { DEFAULT_MIN_PASSWORD_LENGTH } from "../src/lib/password.ts";

const allPasswords = Object.values(COMMON_PASSWORDS_BY_LENGTH).flat();

describe("the generated list", () => {
  test("contains 3000 passwords that the password methods accept", () => {
    const methodPasswords = allPasswords.filter((password) => [...password].length >= DEFAULT_MIN_PASSWORD_LENGTH);
    expect(methodPasswords.length).toBe(3000);
  });

  // Beyond upstream: the 3000 most frequent of the component's floor, 8 or more, are in it too.
  test("contains the passwords of 8 and 9 characters among the 3000 most frequent of 8 or more", () => {
    expect([COMMON_PASSWORDS_BY_LENGTH[8]!.length, COMMON_PASSWORDS_BY_LENGTH[9]!.length]).toEqual([1676, 747]);
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

  test("finds a frequent password that only the component accepts", () => {
    expect(isCommonPassword("password")).toBe(true);
    expect(isCommonPassword("12345678")).toBe(true);
  });

  test("does not find a password that is too short for the list", () => {
    expect(isCommonPassword("passwor")).toBe(false);
    expect(isCommonPassword("")).toBe(false);
  });
});
