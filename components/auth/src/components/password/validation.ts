// What a password may be (STUDY-201 §1.6, STUDY-208 §1.11), v2.0.0's rules (NIST's, as
// https://auth.pilcrowonpaper.com/passwords sums them up): 8 to 100 characters, counted in code points of the input as
// given, at least the caller's minimum; no surrounding whitespace (Unicode's); and, for a new password, not one of the
// most frequent ones. Hashing and checking take the NFC form. The password methods ask for 10
// (`DEFAULT_MIN_PASSWORD_LENGTH`, `lib/password.ts`).
import { type Infer, v } from "@bunvex/values";
import { isCommonPassword } from "./commonPasswords.ts";

/**
 * The shortest password the component accepts, in code points, in `_internal_dangerous_setPassword` and
 * `verifyPassword`. Lower than the password methods' minimum (10), so the component verifies the passwords of other
 * systems with this minimum.
 */
export const MIN_PASSWORD_LENGTH = 8;
/** The longest password, in code points. */
export const MAX_PASSWORD_LENGTH = 100;

/** A password's format refused, with its limit where it has one: safe to show the user. */
export const passwordFormatUserError = v.union(
  v.object({ error: v.literal("PASSWORD_TOO_SHORT"), minimumLength: v.number() }),
  v.object({ error: v.literal("PASSWORD_TOO_LONG"), maximumLength: v.number() }),
  v.object({ error: v.literal("PASSWORD_HAS_SURROUNDING_WHITESPACE") }),
);
/** A password's format refused. */
export type PasswordFormatUserError = Infer<typeof passwordFormatUserError>;

/** Why a new password was refused: its format, or it is too common. Safe to show the user. */
export const setPasswordUserError = v.union(
  passwordFormatUserError,
  v.object({ error: v.literal("PASSWORD_TOO_COMMON") }),
);
/** Why a new password was refused. */
export type SetPasswordUserError = Infer<typeof setPasswordUserError>;

/**
 * Why a password check failed: its format, wrong credentials, or too many attempts (and when to try again). Safe to
 * show the user; a method's own results reuse it.
 */
export const verifyPasswordUserError = v.union(
  passwordFormatUserError,
  v.object({ error: v.literal("INVALID_CREDENTIALS") }),
  v.object({ error: v.literal("RATE_LIMITED"), retryAfterMs: v.number() }),
);
/** Why a password check failed. */
export type VerifyPasswordUserError = Infer<typeof verifyPasswordUserError>;

/**
 * The first format rule `password` breaks, with `minimumLength` its shortest length, or null; it does not look at the
 * common passwords. Throws when `minimumLength` is not between {@link MIN_PASSWORD_LENGTH} and
 * {@link MAX_PASSWORD_LENGTH}: the caller's mistake, not the user's.
 */
export function validatePasswordInputFormat(password: string, minimumLength: number): PasswordFormatUserError | null {
  // Negated, so `NaN` is refused too: every comparison with it is false.
  if (!(minimumLength >= MIN_PASSWORD_LENGTH && minimumLength <= MAX_PASSWORD_LENGTH))
    throw new Error(
      `minimumLength must be between ${MIN_PASSWORD_LENGTH} and ${MAX_PASSWORD_LENGTH}, but it is ${minimumLength}.`,
    );
  // Code points, not UTF-16 units: an emoji is one character, as NIST means it.
  const length = [...password].length;
  if (length < minimumLength) return { error: "PASSWORD_TOO_SHORT", minimumLength };
  if (length > MAX_PASSWORD_LENGTH) return { error: "PASSWORD_TOO_LONG", maximumLength: MAX_PASSWORD_LENGTH };
  // `\s` under `u` is Unicode's whitespace (a no-break space too), which `trim()` comparisons would let through.
  if (/^\s|\s$/u.test(password)) return { error: "PASSWORD_HAS_SURROUNDING_WHITESPACE" };
  return null;
}

/**
 * The first rule a new password (a sign-up's, a change's) breaks, with `minimumLength` its shortest length, the common
 * passwords included, or null. Throws for a `minimumLength` out of range, as {@link validatePasswordInputFormat}.
 */
export function validateNewPassword(password: string, minimumLength: number): SetPasswordUserError | null {
  return (
    validatePasswordInputFormat(password, minimumLength) ??
    (isCommonPassword(password) ? { error: "PASSWORD_TOO_COMMON" } : null)
  );
}

/** The form a password is hashed and checked in: NFC, so one a user sees as the same hashes the same. */
export function normalizePassword(password: string): string {
  return password.normalize("NFC");
}
