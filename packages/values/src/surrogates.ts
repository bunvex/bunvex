// Strings with a lone surrogate (STUDY-135). A JS string may hold a UTF-16 unit from U+D800 to U+DFFF with no
// partner; a Rust string cannot. Convex sends values to Rust as `JSON.stringify` text, which escapes such a
// unit as `\udXXX`, and `serde_json` refuses the escape. These helpers find one, and say what serde says.

// A high surrogate with no low one after it, or a low one with no high one before it. (Not `isWellFormed` /
// `toWellFormed`: an app's tsconfig need not have ES2024's lib, and it typechecks these sources.)
const LONE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const LONE_ALL = new RegExp(LONE.source, "g");

/** True when `s` holds a lone surrogate. */
export const hasLoneSurrogate = (s: string): boolean => LONE.test(s);

/** `s` with each lone surrogate replaced by U+FFFD, as Convex's lossy conversion into Rust does. */
export const withoutLoneSurrogates = (s: string): string => (LONE.test(s) ? s.replace(LONE_ALL, "\ufffd") : s);

/**
 * True when a string anywhere in `v` (a field name included) holds a lone surrogate. Iterative: a value may
 * nest far deeper than the stack (its nesting is refused with Convex's message after this check).
 */
export function valueHasLoneSurrogate(v: unknown): boolean {
  const stack: unknown[] = [v];
  while (stack.length) {
    const x = stack.pop();
    if (typeof x === "string") {
      if (hasLoneSurrogate(x)) return true;
    } else if (Array.isArray(x)) {
      for (const e of x) stack.push(e);
    } else if (x !== null && typeof x === "object" && !ArrayBuffer.isView(x) && !(x instanceof ArrayBuffer)) {
      for (const [k, e] of Object.entries(x)) {
        if (hasLoneSurrogate(k)) return true;
        stack.push(e);
      }
    }
  }
  return false;
}

/** The UTF-8 length of the character starting at `i` (a valid pair is one character of 4 bytes). */
function utf8Length(text: string, i: number): { bytes: number; units: number } {
  const c = text.charCodeAt(i);
  if (c < 0x80) return { bytes: 1, units: 1 };
  if (c < 0x800) return { bytes: 2, units: 1 };
  if (c >= 0xd800 && c <= 0xdbff) {
    const d = text.charCodeAt(i + 1);
    if (d >= 0xdc00 && d <= 0xdfff) return { bytes: 4, units: 2 };
  }
  return { bytes: 3, units: 1 };
}

const hex = (text: string, at: number) => Number.parseInt(text.slice(at, at + 4), 16);
const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/**
 * serde_json's refusal of JSON text that `JSON.stringify` wrote, as Convex reports it: "lone leading surrogate
 * in hex escape" for a low surrogate first (or a high one followed by a `\u` escape that is not a low one),
 * "unexpected end of hex escape" for a high surrogate not followed by `\u`, each "at line 1 column N" where N
 * counts the UTF-8 bytes serde consumed (serde_json 1.0.151 `parse_unicode_escape`, `SliceRead::position`).
 * Null when every escape pairs.
 */
export function jsonSurrogateError(text: string): string | null {
  let bytes = 0;
  let inString = false;
  for (let i = 0; i < text.length; ) {
    const c = text.charCodeAt(i);
    if (!inString || c !== 0x5c) {
      if (c === 0x22) inString = !inString;
      const { bytes: b, units } = utf8Length(text, i);
      bytes += b;
      i += units;
      continue;
    }
    // An escape inside a string.
    if (text[i + 1] !== "u") {
      bytes += 2;
      i += 2;
      continue;
    }
    const first = hex(text, i + 2);
    bytes += 6;
    i += 6;
    if (isLow(first)) return `lone leading surrogate in hex escape at line 1 column ${bytes}`;
    if (!isHigh(first)) continue;
    // serde takes the next byte (one byte, even of a longer character), then the one after, expecting `\u`.
    if (text[i] !== "\\") return `unexpected end of hex escape at line 1 column ${bytes + 1}`;
    if (text[i + 1] !== "u") return `unexpected end of hex escape at line 1 column ${bytes + 2}`;
    const second = hex(text, i + 2);
    bytes += 6;
    i += 6;
    if (!isLow(second)) return `lone leading surrogate in hex escape at line 1 column ${bytes}`;
  }
  return null;
}

/**
 * Convex sends a value to Rust as `JSON.stringify` text, and serde refuses a string with a lone surrogate
 * (STUDY-135): the call fails with "Received invalid json: …", the column counted in that text, whose shape
 * `text` builds as Convex's JS does for the call. Only a value that holds one pays for building it.
 */
export function refuseLoneSurrogates(value: unknown, text: () => string): void {
  if (!valueHasLoneSurrogate(value)) return;
  const e = jsonSurrogateError(text());
  if (e) throw new Error(`Received invalid json: ${e}`);
}
