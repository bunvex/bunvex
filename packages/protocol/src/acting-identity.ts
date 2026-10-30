// The identity an admin acts as (STUDY-34, STUDY-188 R5): Convex's `UserIdentityAttributes` read from JSON
// (crates/convex/sync_types/src/types/json.rs, `UserIdentityAttributesJson` and its `TryFrom<JsonValue>`). An
// object with `tokenIdentifier`, or `issuer` and `subject`; the standard fields typed, every other field a custom
// claim. A refusal carries serde's wording (what Convex's sync socket sends after "Received Invalid JSON on
// websocket: "), checked on Convex's binary.

const STRING_FIELDS = new Set([
  "tokenIdentifier",
  "issuer",
  "subject",
  "name",
  "givenName",
  "familyName",
  "nickname",
  "preferredUsername",
  "profileUrl",
  "pictureUrl",
  "websiteUrl",
  "email",
  "gender",
  "birthday",
  "timezone",
  "language",
  "phoneNumber",
  "address",
  "updatedAt",
]);
const BOOL_FIELDS = new Set(["emailVerified", "phoneNumberVerified"]);

// The message is serde's, or Convex's own for a missing identifier.
/** An acting identity that is not one, with the first problem found. */
export class ActingIdentityError extends Error {}

// In the order Convex finds them.
/**
 * The acting identity of `json`, `tokenIdentifier` set (`issuer|subject` when not given) and null fields dropped.
 * Throws `ActingIdentityError` with the first problem, in this order: the value's type, then each standard field in the
 * object's order, then the missing identifier.
 */
export function parseActingIdentity(json: unknown): Record<string, unknown> {
  if (typeof json !== "object" || json === null || Array.isArray(json))
    throw new ActingIdentityError(`invalid type: ${unexpected(json)}, expected struct UserIdentityAttributesJson`);
  const o = json as Record<string, unknown>;
  for (const [k, x] of Object.entries(o)) {
    if (x === null || x === undefined) continue; // an absent `Option`
    if (STRING_FIELDS.has(k) && typeof x !== "string")
      throw new ActingIdentityError(`invalid type: ${unexpected(x)}, expected a string`);
    if (BOOL_FIELDS.has(k) && typeof x !== "boolean")
      throw new ActingIdentityError(`invalid type: ${unexpected(x)}, expected a boolean`);
  }
  let tokenIdentifier = o.tokenIdentifier ?? undefined;
  if (tokenIdentifier === undefined) {
    if (typeof o.issuer !== "string" || typeof o.subject !== "string")
      throw new ActingIdentityError('Either "tokenIdentifier" or "issuer" and "subject" must be set');
    tokenIdentifier = `${o.issuer}|${o.subject}`;
  }
  const out: Record<string, unknown> = { tokenIdentifier };
  for (const [k, v] of Object.entries(o)) if (k !== "tokenIdentifier" && v !== null && v !== undefined) out[k] = v;
  return out;
}

/** serde's `Unexpected` for a JSON value (serde_json's wording for its numbers). */
function unexpected(x: unknown): string {
  if (typeof x === "boolean") return `boolean \`${x}\``;
  if (typeof x === "number") {
    // serde_json reads an integer literal as u64 / i64 and anything else as f64; JSON.parse has lost which, so
    // an integral value in range is an integer (`1.0` and `1e2` were floats on Convex).
    if (Number.isInteger(x) && !Object.is(x, -0) && x >= -(2 ** 63) && x < 2 ** 64) return `integer \`${BigInt(x)}\``;
    return `floating point \`${float(x)}\``;
  }
  if (typeof x === "string") return `string ${debugString(x)}`;
  if (Array.isArray(x)) return "sequence";
  if (x === null) return "unit value";
  return "map";
}

/**
 * A float as serde_json writes it: the shortest digits that round-trip, positional while the decimal point
 * falls within 16 digits left or 5 right of them, otherwise `d.ddde±x`; a positional integer ends in `.0`.
 */
function float(x: number): string {
  const sign = x < 0 || Object.is(x, -0) ? "-" : "";
  const [mantissa = "", exp = "0"] = Math.abs(x).toExponential().split("e");
  const digits = mantissa.replace(".", "");
  const point = Number(exp) + 1; // the decimal point's place after the first digit
  if (point > 16 || point <= -5) {
    const e = point - 1;
    const d = digits.length === 1 ? digits : `${digits[0]}.${digits.slice(1)}`;
    return `${sign}${d}e${e > 0 ? "+" : ""}${e}`;
  }
  if (point <= 0) return `${sign}0.${"0".repeat(-point)}${digits}`;
  if (point >= digits.length) return `${sign}${digits}${"0".repeat(point - digits.length)}.0`;
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

// What Rust's `str` Debug escapes as `\u{…}`: the characters it does not print (control, format, private use,
// unassigned, line and paragraph separators, spaces other than ' ') and grapheme extenders.
const UNPRINTABLE = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Zl}\p{Zp}\p{Grapheme_Extend}]|(?! )\p{Zs}/u;
const SHORT: Record<string, string> = { "\0": "\\0", "\t": "\\t", "\r": "\\r", "\n": "\\n", '"': '\\"', "\\": "\\\\" };

/** A string as Rust's `{:?}` writes it. */
function debugString(s: string): string {
  let out = '"';
  for (const c of s) {
    const short = SHORT[c];
    if (short !== undefined) out += short;
    else if (UNPRINTABLE.test(c)) out += `\\u{${c.codePointAt(0)?.toString(16)}}`;
    else out += c;
  }
  return `${out}"`;
}
