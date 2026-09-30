// The identity the runner acts as (STUDY-12 §10.3), written as a literal and checked as Convex's
// `parseImpersonatedUser` does: `subject` and `issuer` (text) are required; the OpenID claims have their
// types; `customClaims` is an object of claims, flattened into the identity; anything else is a claim too.
import type { UserIdentity, Value } from "../data-source.ts";
import { formatLiteral, parseLiteral, UNSET } from "../database/literal.ts";

/** Convex's default for the runner's identity. */
export const DEFAULT_IDENTITY = formatLiteral({ subject: "fake_id", issuer: "fake_issuer" }, "  ");

const TEXT_CLAIMS = [
  "name",
  "givenName",
  "familyName",
  "nickname",
  "preferredUsername",
  "profileUrl",
  "pictureUrl",
  "email",
  "gender",
  "birthday",
  "timezone",
  "language",
  "phoneNumber",
  "address",
  "updatedAt",
];
const YES_NO_CLAIMS = ["emailVerified", "phoneNumberVerified"];

export type ParsedIdentity = { ok: true; identity: UserIdentity } | { ok: false; error: string; offset?: number };

const isObject = (v: unknown): v is Record<string, Value> =>
  typeof v === "object" && v !== null && !Array.isArray(v) && !("$integer" in v) && !("$bytes" in v);

export function parseIdentity(text: string): ParsedIdentity {
  const r = parseLiteral(text);
  if (!r.ok) return { ok: false, error: r.error, offset: r.offset };
  if (r.value === UNSET || !isObject(r.value))
    return { ok: false, error: "The identity is one object: { subject, issuer, … }" };
  const v: Record<string, Value> = r.value;
  for (const k of ["subject", "issuer"])
    if (typeof v[k] !== "string") return { ok: false, error: `The identity needs "${k}", as text.` };
  for (const k of TEXT_CLAIMS) if (k in v && typeof v[k] !== "string") return { ok: false, error: `"${k}" is text.` };
  for (const k of YES_NO_CLAIMS)
    if (k in v && typeof v[k] !== "boolean") return { ok: false, error: `"${k}" is true or false.` };
  const { customClaims, ...claims } = v;
  if (customClaims !== undefined && !isObject(customClaims))
    return { ok: false, error: `"customClaims" is an object of claims.` };
  return { ok: true, identity: { ...claims, ...(customClaims ?? {}) } as UserIdentity };
}
