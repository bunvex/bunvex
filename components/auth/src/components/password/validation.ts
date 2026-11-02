// What a password may be (STUDY-201 §1.6), v2's rules (NIST's, as https://auth.pilcrowonpaper.com/passwords sums them
// up): 10 to 100 characters, counted in code points of the input as given; no surrounding whitespace (Unicode's);
// and, for a new password, not one of the most frequent ones. Hashing and checking take the NFC form.
import { type Infer, v } from "@bunvex/values";
import { isCommonPassword } from "./commonPasswords.ts";

/** The shortest password, in code points. */
export const MIN_PASSWORD_LENGTH = 10;
/** The shortest password the password methods accept, for a sign-up form to show the same limit. */
export const DEFAULT_MIN_PASSWORD_LENGTH = MIN_PASSWORD_LENGTH;
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

/** The first format rule `password` breaks, or null; it does not look at the common passwords. */
export function validatePasswordInputFormat(password: string): PasswordFormatUserError | null {
  // Code points, not UTF-16 units: an emoji is one character, as NIST means it.
  const length = [...password].length;
  if (length < MIN_PASSWORD_LENGTH) return { error: "PASSWORD_TOO_SHORT", minimumLength: MIN_PASSWORD_LENGTH };
  if (length > MAX_PASSWORD_LENGTH) return { error: "PASSWORD_TOO_LONG", maximumLength: MAX_PASSWORD_LENGTH };
  // `\s` under `u` is Unicode's whitespace (a no-break space too), which `trim()` comparisons would let through.
  if (/^\s|\s$/u.test(password)) return { error: "PASSWORD_HAS_SURROUNDING_WHITESPACE" };
  return null;
}

/** The first rule a new password (a sign-up's, a change's) breaks, the common passwords included, or null. */
export function validateNewPassword(password: string): SetPasswordUserError | null {
  return (
    validatePasswordInputFormat(password) ?? (isCommonPassword(password) ? { error: "PASSWORD_TOO_COMMON" } : null)
  );
}

/** The form a password is hashed and checked in: NFC, so one a user sees as the same hashes the same. */
export function normalizePassword(password: string): string {
  return password.normalize("NFC");
}
