// The most frequent passwords, refused for a new password (OWASP ASVS L1 2.1.7, NIST SP 800-63B): v2's list and
// lookup (STUDY-201 §1.6). The list (`commonPasswords.generated.ts`, by `scripts/common-passwords.ts`) is keyed by
// length, each length's passwords sorted, so a lookup is one binary search in one short array.
import { COMMON_PASSWORDS_BY_LENGTH } from "./commonPasswords.generated.ts";

/**
 * Whether `password` is one of the most frequent passwords, compared as the list is stored: NFC, then lowercase (so
 * `Password123`-style variants are caught too).
 */
export function isCommonPassword(password: string): boolean {
  const wanted = password.normalize("NFC").toLowerCase();
  // In code points, as the generator and the length rule count.
  const sorted = COMMON_PASSWORDS_BY_LENGTH[[...wanted].length];
  if (sorted === undefined) return false;
  // The generator sorts with JavaScript's default comparison, the one `<` makes.
  let low = 0;
  let high = sorted.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const candidate = sorted[mid]!;
    if (candidate === wanted) return true;
    if (candidate < wanted) low = mid + 1;
    else high = mid - 1;
  }
  return false;
}
