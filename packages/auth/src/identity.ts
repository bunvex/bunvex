// The identity a function sees (STUDY-27 §1.3), as Convex's `UserIdentity` (crates/keybroker/src/broker.rs
// `from_token` / `from_custom_jwt`, crates/convex/sync_types/src/types/json.rs): `tokenIdentifier` is
// `issuer|subject`, the standard OIDC claims become camelCase fields, the rest stay at the top level.
import type { JSONValue } from "@bunvex/values";

export interface UserIdentity {
  readonly tokenIdentifier: string;
  readonly subject: string;
  readonly issuer: string;
  readonly name?: string;
  readonly givenName?: string;
  readonly familyName?: string;
  readonly nickname?: string;
  readonly preferredUsername?: string;
  readonly profileUrl?: string;
  readonly pictureUrl?: string;
  readonly email?: string;
  readonly emailVerified?: boolean;
  readonly gender?: string;
  readonly birthday?: string;
  readonly timezone?: string;
  readonly language?: string;
  readonly phoneNumber?: string;
  readonly phoneNumberVerified?: boolean;
  readonly address?: string;
  readonly updatedAt?: string;
  readonly [key: string]: JSONValue | undefined;
}

/** A verified identity and when its token expires (seconds since the epoch), for the sync protocol's checks. */
export type VerifiedIdentity = { identity: UserIdentity; expiresAt: number };

type Claims = Record<string, unknown>;

/** OIDC claims that are typed fields, or registered and housekeeping ones: never custom claims. */
const NOT_CUSTOM_OIDC = new Set([
  // OIDC core ID-token claims (not "additional claims" in Convex's verifier)
  "iss",
  "sub",
  "aud",
  "exp",
  "iat",
  "auth_time",
  "nonce",
  "acr",
  "amr",
  "azp",
  "at_hash",
  "c_hash",
  // the standard claims surfaced as fields
  "name",
  "given_name",
  "family_name",
  "nickname",
  "preferred_username",
  "profile",
  "picture",
  "website",
  "email",
  "email_verified",
  "gender",
  "birthdate",
  "zoneinfo",
  "locale",
  "phone_number",
  "phone_number_verified",
  "address",
  "updated_at",
  // vary across refreshes and would bust the query cache
  "jti",
  "nbf",
  "fva",
]);
/** Registered JWT claims: not private claims of a custom JWT. */
const REGISTERED = new Set(["iss", "sub", "aud", "exp", "nbf", "iat", "jti"]);

const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const bool = (v: unknown) => (typeof v === "boolean" ? v : undefined);

/** chrono's `to_rfc3339` of a seconds timestamp: `2024-01-02T03:04:05+00:00` (fractions only when present). */
function rfc3339(seconds: number): string {
  const iso = new Date(seconds * 1000).toISOString();
  return iso.replace(/\.000Z$/, "+00:00").replace(/Z$/, "+00:00");
}

function compact<T extends Record<string, unknown>>(o: T): T {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}

/** The identity of a verified OIDC ID token. */
export function identityFromOidc(claims: Claims): UserIdentity {
  const issuer = String(claims.iss);
  const subject = String(claims.sub);
  const address = claims.address as { formatted?: unknown } | undefined;
  const custom: Record<string, JSONValue> = {};
  for (const [k, v] of Object.entries(claims)) if (!NOT_CUSTOM_OIDC.has(k)) custom[k] = v as JSONValue;
  return compact({
    tokenIdentifier: `${issuer}|${subject}`,
    issuer,
    subject,
    name: str(claims.name),
    givenName: str(claims.given_name),
    familyName: str(claims.family_name),
    nickname: str(claims.nickname),
    preferredUsername: str(claims.preferred_username),
    profileUrl: str(claims.profile),
    pictureUrl: str(claims.picture),
    websiteUrl: str(claims.website),
    email: str(claims.email),
    emailVerified: bool(claims.email_verified),
    gender: str(claims.gender),
    birthday: str(claims.birthdate),
    timezone: str(claims.zoneinfo),
    language: str(claims.locale),
    phoneNumber: str(claims.phone_number),
    phoneNumberVerified: bool(claims.phone_number_verified),
    address: str(address?.formatted),
    updatedAt: typeof claims.updated_at === "number" ? rfc3339(claims.updated_at) : undefined,
    ...sorted(custom),
  }) as UserIdentity;
}

/** Nested objects of a custom JWT's claims flattened into dotted keys, as Convex's `extract_custom_jwt_claims`. */
function flatten(o: Claims, prefix = "", out: Record<string, JSONValue> = {}) {
  for (const [k, v] of Object.entries(o)) {
    if (typeof v === "object" && v !== null && !Array.isArray(v)) flatten(v as Claims, `${prefix}${k}.`, out);
    else out[`${prefix}${k}`] = v as JSONValue;
  }
  return out;
}

const sorted = (o: Record<string, JSONValue>) =>
  Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));

/** The identity of a verified custom JWT: subject and issuer, every private claim flattened, `fva` dropped. */
export function identityFromCustomJwt(claims: Claims): UserIdentity {
  const issuer = String(claims.iss);
  const subject = String(claims.sub);
  const priv: Claims = {};
  for (const [k, v] of Object.entries(claims)) if (!REGISTERED.has(k)) priv[k] = v;
  const custom = flatten(priv);
  delete custom.fva;
  return { tokenIdentifier: `${issuer}|${subject}`, issuer, subject, ...sorted(custom) } as UserIdentity;
}
