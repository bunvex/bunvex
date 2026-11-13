// What a username may be (STUDY-201 §1.7, STUDY-208 §1.12), v2.0.0's rules: 1 to 100 code points once normalized (the
// maximum, `d3aa3b56`, keeps a username far below a document's size limit, and is checked first); no surrounding
// whitespace; none of the code points below, nor a leading combining mark. Inner spaces, ZWJ and ZWNJ are allowed.
// Usernames compare lowercased, then NFC (the other order of the common-password lookup's, on purpose: the lowercasing
// can leave a string that is not NFC).
import { type Infer, v } from "@bunvex/values";

/** The shortest username, in code points once normalized. */
export const MIN_USERNAME_LENGTH = 1;
/** The longest username, in code points once normalized. */
export const MAX_USERNAME_LENGTH = 100;

/** Why `setUsername` refused a username: a code to show the user (`error`), with its limit where it has one. */
export const setUsernameUserError = v.union(
  v.object({ error: v.literal("USERNAME_TOO_SHORT"), minimumLength: v.number() }),
  v.object({ error: v.literal("USERNAME_TOO_LONG"), maximumLength: v.number() }),
  v.object({ error: v.literal("USERNAME_HAS_SURROUNDING_WHITESPACE") }),
  v.object({ error: v.literal("USERNAME_HAS_INVALID_CHARACTERS") }),
  v.object({ error: v.literal("USERNAME_TAKEN") }),
);

/** Why `setUsername` refused a username. */
export type SetUsernameUserError = Infer<typeof setUsernameUserError>;

// Bidirectional and invisible formatting characters: the Arabic letter mark, the zero-width space, the left-to-right
// and right-to-left marks, embeddings, overrides and isolates, and the byte order mark.
const INVISIBLE_OR_BIDI = new Set([
  0x061c, 0x200b, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0xfeff,
]);
// Spaces other than ASCII's: no-break, ogham, the en/em family (U+2000–U+200A), narrow no-break, medium mathematical
// and ideographic.
const OTHER_SPACES = new Set([
  0x00a0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x202f,
  0x205f, 0x3000,
]);

/** Whether a code point is never allowed: controls, surrogates, formatting characters, odd spaces, noncharacters. */
function forbidden(cp: number): boolean {
  return (
    cp <= 0x1f || // C0 controls
    (cp >= 0x7f && cp <= 0x9f) || // DEL and C1 controls
    (cp >= 0xd800 && cp <= 0xdfff) || // lone surrogates
    INVISIBLE_OR_BIDI.has(cp) ||
    OTHER_SPACES.has(cp) ||
    (cp >= 0xfdd0 && cp <= 0xfdef) || // noncharacters
    (cp & 0xfffe) === 0xfffe // U+xxFFFE and U+xxFFFF in every plane
  );
}

/** The first rule `username` breaks, or null when it is a valid username. */
export function validateUsernameFormat(username: string): SetUsernameUserError | null {
  if (isTooLong(username)) return { error: "USERNAME_TOO_LONG", maximumLength: MAX_USERNAME_LENGTH };
  if (/^\s|\s$/u.test(username)) return { error: "USERNAME_HAS_SURROUNDING_WHITESPACE" };
  for (const character of username)
    if (forbidden(character.codePointAt(0)!)) return { error: "USERNAME_HAS_INVALID_CHARACTERS" };
  if (/^\p{M}/u.test(username)) return { error: "USERNAME_HAS_INVALID_CHARACTERS" };
  if ([...normalizeUsername(username)].length < MIN_USERNAME_LENGTH)
    return { error: "USERNAME_TOO_SHORT", minimumLength: MIN_USERNAME_LENGTH };
  return null;
}

/**
 * Whether a username has more than {@link MAX_USERNAME_LENGTH} code points once normalized: no stored username is
 * that long, so a lookup can skip the database for it.
 */
export function isTooLong(username: string): boolean {
  return [...normalizeUsername(username)].length > MAX_USERNAME_LENGTH;
}

/** The form usernames compare in: lowercase, then NFC, so case and normalization form do not tell two apart. */
export function normalizeUsername(username: string): string {
  return username.toLowerCase().normalize("NFC");
}
