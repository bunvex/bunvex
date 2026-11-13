// The password methods' minimum length (STUDY-208 §1.11), v2.0.0's `lib/password.ts` (`30169ef0`): no longer the
// component's floor (`MIN_PASSWORD_LENGTH`, 8), which verifies shorter passwords set by other systems.

/**
 * The shortest new password the password methods accept, in code points, for a sign-up form to show the same limit.
 * The password component accepts shorter ones (8), so the methods pass this minimum to it.
 */
export const DEFAULT_MIN_PASSWORD_LENGTH = 10;
