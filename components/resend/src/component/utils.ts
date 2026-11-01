// Small helpers of the component (STUDY-200 §1.5, §1.6, §1.14), as Convex's resend 0.2.10 has them in
// `src/component/utils.ts` and `lib.ts`, plus the structural equality it takes from remeda (R-5).
import { parse } from "@bunvex/helpers/validators";
import type { Infer, Validator } from "@bunvex/values";

/** Unreachable: every event type is handled. */
export function assertExhaustive(value: never): never {
  throw new Error(`Unhandled event type: ${value as string}`);
}

/** `parse(validator, value)` without throwing: the parsed value (unknown fields stripped), or the error. */
export function attemptToParse<
  // biome-ignore lint/suspicious/noExplicitAny: any validator
  T extends Validator<any, any>,
>(validator: T, value: unknown): { kind: "success"; data: Infer<T> } | { kind: "error"; error: unknown } {
  try {
    return { kind: "success", data: parse(validator, value) };
  } catch (error) {
    return { kind: "error", error };
  }
}

/** The local parts of Resend's test addresses. */
export const RESEND_TEST_EMAILS = ["delivered", "bounced", "complained"];

// What `sendEmail` checks in test mode (Convex's `isTestEmail`, `lib.ts:44-58`): the text after the first `@` and
// before any second one must be `resend.dev`, and the text before it one of the test local parts, alone or followed by
// `+` and anything. Laxer than `isValidResendTestEmail` and the README (R-6 keeps it so): `delivered+a.b@resend.dev`
// passes; `a@b@resend.dev` and a display name fail.
/** Whether `sendEmail` accepts `email` in test mode. */
export function isTestEmail(email: string): boolean {
  const parts = email.split("@");
  const local = parts[0] ?? "";
  if (parts[1] !== "resend.dev") return false;
  return RESEND_TEST_EMAILS.some((name) => local === name || local.startsWith(`${name}+`));
}

// Convex's `isValidResendTestEmail` (`utils.ts:22-31`), stricter than `isTestEmail`: a label of letters, digits, `_`
// and `-` only. Nothing calls it; it is kept with its tests.
const STRICT_TEST_ADDRESS = /^(delivered|bounced|complained)(\+[a-zA-Z0-9_-]*)?@resend\.dev$/;

/** Whether `email` is one of Resend's test addresses, with an optional label of letters, digits, `_` and `-`. */
export function isValidResendTestEmail(email: string): boolean {
  return STRICT_TEST_ADDRESS.test(email);
}

// remeda's `isDeepEqual` (R-5), for the stored and the new options: equal by `Object.is`, or two arrays of equal
// items, or two objects of comparable prototypes (the same one, or a plain one against a null one) with as many own
// enumerable keys and each of `a`'s keys in `b` with an equal value. So a key holding `undefined` counts: `{ a:
// undefined }` is not `{}`. Maps, sets, dates and regular expressions, which no option holds, are not handled apart.
/** Whether `a` and `b` are structurally equal. */
export function isDeepEqual(a: unknown, b: unknown): boolean {
  if (a === b || Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (!comparablePrototypes(a, b)) return false;
  if (Array.isArray(a)) {
    const other = b as unknown[];
    return a.length === other.length && a.every((item, i) => isDeepEqual(item, other[i]));
  }
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every(
    (key) => key in b && isDeepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
  );
}

function comparablePrototypes(a: object, b: object): boolean {
  const pa = Object.getPrototypeOf(a);
  const pb = Object.getPrototypeOf(b);
  if (pa === pb) return true;
  return (pa === null && pb === Object.prototype) || (pa === Object.prototype && pb === null);
}
