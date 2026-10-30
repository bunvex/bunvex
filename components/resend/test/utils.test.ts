// Upstream's `src/component/utils.test.ts` (get-convex/resend 0.2.10), ported: `isValidResendTestEmail`, the strict
// check no shipped code calls. Then the checks the component does use: `isTestEmail`, laxer (STUDY-200 §2.3, kept by
// R-6), and the deep equality written for `lastOptions` in place of remeda's (R-5).
import { describe, expect, it } from "bun:test";
import { isDeepEqual, isTestEmail, isValidResendTestEmail } from "../src/component/utils.ts";

describe("isValidResendTestEmail", () => {
  it("allows valid test emails without labels", () => {
    expect(isValidResendTestEmail("delivered@resend.dev")).toBe(true);
    expect(isValidResendTestEmail("bounced@resend.dev")).toBe(true);
    expect(isValidResendTestEmail("complained@resend.dev")).toBe(true);
  });

  it("allows valid test emails with labels", () => {
    expect(isValidResendTestEmail("delivered+user-1@resend.dev")).toBe(true);
    expect(isValidResendTestEmail("delivered+foo-bar@resend.dev")).toBe(true);
    expect(isValidResendTestEmail("bounced+user-pw-reset-test@resend.dev")).toBe(true);
    expect(isValidResendTestEmail("complained+account-reset_test1@resend.dev")).toBe(true);
    expect(isValidResendTestEmail("complained+@resend.dev")).toBe(true);
    expect(isValidResendTestEmail("complained+COMPLAINED@resend.dev")).toBe(true);
  });

  it("rejects invalid test emails with or without labels", () => {
    expect(isValidResendTestEmail("foobar@resend.dev")).toBe(false);
    expect(isValidResendTestEmail("bazfoo+user@resend.dev")).toBe(false);
    expect(isValidResendTestEmail("delivered@resended.dev")).toBe(false);
  });

  it("rejects test emails with disallowed special characters in the label", () => {
    expect(isValidResendTestEmail("delivered+foo.bar@resend.dev")).toBe(false);
    expect(isValidResendTestEmail("bounced+user/1@resend.dev")).toBe(false);
    expect(isValidResendTestEmail("bounced+user$1@resend.dev")).toBe(false);
  });
});

describe("isTestEmail (what sendEmail checks in test mode)", () => {
  it("accepts the three local parts, alone or with any label, and ignores what follows a second @", () => {
    for (const ok of [
      "delivered@resend.dev",
      "bounced@resend.dev",
      "complained@resend.dev",
      "delivered+@resend.dev",
      "delivered+foo.bar@resend.dev",
      "bounced+user/1@resend.dev",
      "complained+a b@resend.dev",
      // Only the text between the first and second `@` is the domain.
      "delivered@resend.dev@x",
    ])
      expect([ok, isTestEmail(ok)]).toEqual([ok, true]);
  });

  it("refuses another domain or local part, a display name, a second @, case changes and no @", () => {
    for (const bad of [
      "foobar@resend.dev",
      "deliveredx@resend.dev",
      "delivered-x@resend.dev",
      "delivered@resended.dev",
      "delivered@resend.dev.com",
      "Delivered@resend.dev",
      "delivered@RESEND.dev",
      "X <delivered@resend.dev>",
      "a@b@resend.dev",
      "delivered",
      "",
    ])
      expect([bad, isTestEmail(bad)]).toEqual([bad, false]);
  });
});

describe("isDeepEqual (remeda's semantics)", () => {
  it("is equal on primitives by Object.is, NaN included, and unequal across types", () => {
    expect(isDeepEqual(1, 1)).toBe(true);
    expect(isDeepEqual(Number.NaN, Number.NaN)).toBe(true);
    expect(isDeepEqual("a", "a")).toBe(true);
    expect(isDeepEqual(1, "1")).toBe(false);
    expect(isDeepEqual(null, {})).toBe(false);
    expect(isDeepEqual(undefined, null)).toBe(false);
  });

  it("compares arrays by length and items, and objects by keys and values, deeply", () => {
    expect(isDeepEqual([1, [2, { a: 3 }]], [1, [2, { a: 3 }]])).toBe(true);
    expect(isDeepEqual([1, 2], [1, 2, 3])).toBe(false);
    expect(isDeepEqual({ a: 1, b: { c: "x" } }, { b: { c: "x" }, a: 1 })).toBe(true);
    expect(isDeepEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(isDeepEqual([], {})).toBe(false);
  });

  it("counts a key holding undefined", () => {
    expect(isDeepEqual({ a: 1, onEmailEvent: undefined }, { a: 1 })).toBe(false);
    expect(isDeepEqual({ a: 1 }, { a: 1, onEmailEvent: undefined })).toBe(false);
    expect(isDeepEqual({ a: undefined }, { b: undefined })).toBe(false);
    expect(isDeepEqual({ a: undefined }, { a: undefined })).toBe(true);
  });

  it("treats a null-prototype object as a plain one", () => {
    const bare = Object.assign(Object.create(null), { a: 1 });
    expect(isDeepEqual(bare, { a: 1 })).toBe(true);
    expect(isDeepEqual({ a: 1 }, bare)).toBe(true);
  });

  it("compares the runtime options as stored", () => {
    const stored = { initialBackoffMs: 30000, retryAttempts: 5, apiKey: "k", testMode: false };
    expect(isDeepEqual(stored, { ...stored })).toBe(true);
    expect(isDeepEqual(stored, { ...stored, apiKey: "other" })).toBe(false);
    expect(isDeepEqual(stored, { ...stored, onEmailEvent: { fnHandle: "function://x" } })).toBe(false);
  });
});
