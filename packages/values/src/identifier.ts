// Convex's identifiers (`check_valid_identifier`, crates/convex/sync_types/src/identifier.rs): what a table name,
// an index name or a function name must be, and the backend's words when it is not (STUDY-161 §1). The engine,
// the server's path parser and its validator parser share them.

/** Convex's `MAX_IDENTIFIER_LEN`, in UTF-8 bytes. */
export const MAX_IDENTIFIER_LEN = 64;

const NAMED_ESCAPES: Record<string, string> = {
  "\0": "\\0",
  "\t": "\\t",
  "\n": "\\n",
  "\r": "\\r",
  "'": "\\'",
  "\\": "\\\\",
};
/**
 * What Rust does not print as is: `is_printable`'s categories (controls, format characters, surrogates, private use,
 * unassigned, line and paragraph separators, every space but U+0020), and the grapheme extenders (combining marks).
 */
const ESCAPED = /^(?:[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Grapheme_Extend}]|(?! )\p{Zs})$/u;

/** A character as Rust's `{:?}` shows a `char` (`char::escape_debug`): `'-'`, `'\n'`, `'\''`, `'\u{200b}'`, `'é'`. */
export function rustDebugChar(c: string): string {
  const named = NAMED_ESCAPES[c];
  if (named !== undefined) return `'${named}'`;
  if (ESCAPED.test(c)) return `'\\u{${c.codePointAt(0)!.toString(16)}}'`;
  return `'${c}'`;
}

/**
 * Convex's `check_valid_identifier`: why `s` is not an identifier (its message, in its order: the first character,
 * each other character, the length in bytes, all underscores), or null.
 */
export function identifierError(s: string): string | null {
  const chars = [...s];
  const first = chars[0];
  if (first === undefined) return "Identifier cannot be empty";
  if (!/^[A-Za-z_]$/.test(first))
    return `Invalid first character ${rustDebugChar(first)} in ${s}: Identifiers must start with an alphabetic character or underscore`;
  for (const c of chars.slice(1))
    if (!/^[A-Za-z0-9_]$/.test(c))
      return `Identifier ${s} has invalid character ${rustDebugChar(c)}: Identifiers can only contain alphanumeric characters or underscores`;
  // Every character is ASCII by now: its length is its bytes'.
  if (s.length > MAX_IDENTIFIER_LEN) return `Identifier is too long (${s.length} > maximum ${MAX_IDENTIFIER_LEN})`;
  if (chars.every((c) => c === "_")) return `Identifier ${s} cannot have exclusively underscores`;
  return null;
}
