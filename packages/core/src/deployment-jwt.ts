// The deployment's JWT signing key and `ctx.auth.signJwt`'s minting (STUDY-192 §3.1), as Convex's keybroker
// derives and uses them (`crates/keybroker/src/deployment_jwt.rs`):
//
// - a root of 32 bytes is derived from the instance secret by KBKDF ("deployment jwt signing root"), and each key
//   generation's P-256 scalar from the root ("deployment jwt signing key" ‖ generation as u32 BE ‖ attempt as u8),
//   the first attempt whose scalar is in range winning. Nothing is stored: the same secret gives the same keys,
//   so a store Convex's binary wrote serves the JWKS Convex served;
// - generation 0 signs and is the one key the JWKS publishes, its `kid` the RFC 7638 thumbprint;
// - a token is ES256 over `{alg, typ, kid}` and the caller's claims followed by `iss`, `iat` and `exp`, each part
//   base64url without padding, the signature fixed-width (r ‖ s). Its nonce is random: two tokens differ.
//
// Every refusal is Convex's, in Convex's order, with bunvex's words where Convex names itself (DV-578).
import { createECDH, createHash, createPrivateKey, type KeyObject, sign } from "node:crypto";
import { kbkdfCtrHmacSha256 } from "./kbkdf.ts";

const ROOT_LABEL = "deployment jwt signing root";
const KEY_LABEL = "deployment jwt signing key";
/** The generation that signs tokens and that the JWKS publishes. */
const SIGNING_GENERATION = 0;
/** The largest token, in bytes: it has to fit in an auth header. */
export const DEPLOYMENT_JWT_MAX_SIZE = 8000;
/** Claim-name prefixes reserved for the platform, compared ASCII case-insensitively (bunvex's own, DV-578). */
const RESERVED_CLAIM_PREFIXES = ["bunvex", "bvx"];
/** Where a component's issuer lives under the deployment's origin. */
const COMPONENT_ISSUER_PREFIX = "/components/";
/** P-256's group order: a scalar must be in [1, n - 1]. */
const P256_ORDER = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

/**
 * One public key of the JWKS, as Convex's serializes (`biscuit`'s JWK: its common parameters, then the curve's,
 * flattened in that order).
 */
export type DeploymentJwk = {
  use: "sig";
  alg: "ES256";
  kid: string;
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
};
export type DeploymentJwks = { keys: DeploymentJwk[] };

/** A refusal of `signJwt`: Convex's bad request, its `code` and message. */
export class DeploymentJwtError extends Error {
  constructor(
    readonly code: "InvalidJwtRequest" | "InvalidArguments",
    message: string,
  ) {
    super(message);
  }
}

export type DeploymentJwtRequest = {
  /** The deployment's cloud URL (its canonical one if set). */
  origin: string;
  /** The signing function's component path; `""` is the app. */
  signer: string;
  /** The caller's claims, any JSON. */
  claims: Record<string, unknown>;
  /** Whole seconds. */
  expiresIn: number;
  /** The longest lifetime allowed, in seconds (`DEPLOYMENT_JWT_MAX_LIFETIME_SECONDS`). */
  maxLifetime: number;
};

const base64url = (bytes: Uint8Array | string) => Buffer.from(bytes).toString("base64url");

/** One generation of the signing key. */
class DeploymentJwtKey {
  private constructor(
    private readonly key: KeyObject,
    readonly kid: string,
    readonly jwks: DeploymentJwks,
  ) {}

  /** Generation `generation`'s key under `root`: the first in-range scalar of attempts 0 to 255. */
  static derive(root: Uint8Array, generation: number): DeploymentJwtKey {
    for (let attempt = 0; attempt <= 255; attempt++) {
      const label = Buffer.alloc(KEY_LABEL.length + 5);
      label.write(KEY_LABEL, 0, "utf8");
      label.writeUInt32BE(generation, KEY_LABEL.length);
      label.writeUInt8(attempt, KEY_LABEL.length + 4);
      const d = kbkdfCtrHmacSha256(root, label, 32);
      const scalar = BigInt(`0x${Buffer.from(d).toString("hex")}`);
      if (scalar === 0n || scalar >= P256_ORDER) continue;
      return DeploymentJwtKey.fromScalar(d);
    }
    throw new Error("Could not derive a valid P-256 key");
  }

  private static fromScalar(d: Uint8Array): DeploymentJwtKey {
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(d);
    // Uncompressed SEC1 point: 0x04 ‖ x ‖ y.
    const point = ecdh.getPublicKey();
    const x = base64url(point.subarray(1, 33));
    const y = base64url(point.subarray(33, 65));
    const key = createPrivateKey({ key: { kty: "EC", crv: "P-256", x, y, d: base64url(d) }, format: "jwk" });
    const kid = jwkThumbprint(x, y);
    return new DeploymentJwtKey(key, kid, { keys: [{ use: "sig", alg: "ES256", kid, kty: "EC", crv: "P-256", x, y }] });
  }

  /** A signed token for `request` at `nowMs`, or a `DeploymentJwtError`. */
  mint(request: DeploymentJwtRequest, nowMs: number): string {
    const { claims } = request;
    const has = (name: string) => Object.hasOwn(claims, name);
    for (const reserved of ["iss", "iat", "exp"]) {
      if (has(reserved)) throw invalidRequest(`The '${reserved}' claim is set by the deployment and can't be provided`);
    }
    const prefixed = Object.keys(claims).find((name) =>
      RESERVED_CLAIM_PREFIXES.some((p) => startsAsciiCaseless(name, p)),
    );
    if (prefixed !== undefined) {
      throw invalidRequest(
        `The '${prefixed}' claim can't be provided: claim names starting with 'bunvex' or 'bvx' are reserved`,
      );
    }
    // RFC 7519 §4.1.2 makes `sub` a string, and a `customJwt` provider refuses a token whose `sub` is not one.
    if (has("sub") && !(typeof claims.sub === "string" && claims.sub !== "")) {
      throw invalidRequest("The 'sub' claim must be a non-empty string");
    }
    if (has("nbf")) throw invalidRequest("The 'nbf' claim is reserved by the deployment and can't be provided");
    if (request.expiresIn === 0 || request.expiresIn > request.maxLifetime) {
      throw invalidRequest(`expiresIn must be between 1 second and ${request.maxLifetime} seconds`);
    }
    const issuedAt = Math.floor(nowMs / 1000);
    // The caller's claims in their order, then the three the deployment sets (Convex's map keeps insertion order).
    const payload = {
      ...claims,
      iss: deploymentJwtIssuer(request.origin, request.signer),
      iat: issuedAt,
      exp: issuedAt + request.expiresIn,
    };
    const header = { alg: "ES256", typ: "JWT", kid: this.kid };
    const input = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
    const signature = sign("sha256", Buffer.from(input), { key: this.key, dsaEncoding: "ieee-p1363" });
    const token = `${input}.${base64url(signature)}`;
    if (token.length > DEPLOYMENT_JWT_MAX_SIZE) {
      throw invalidRequest(`The token is ${token.length} bytes, over the ${DEPLOYMENT_JWT_MAX_SIZE} byte limit`);
    }
    return token;
  }
}

/** Every generation of the deployment's key, derived on demand from one root. */
export class DeploymentJwtKeys {
  private readonly generations = new Map<number, DeploymentJwtKey>();
  constructor(private readonly root: Uint8Array) {}

  /** From the instance secret's bytes (`kbkdf.ts` `instanceSecretBytes`). */
  static fromSecret(secret: Uint8Array): DeploymentJwtKeys {
    return new DeploymentJwtKeys(kbkdfCtrHmacSha256(secret, ROOT_LABEL, 32));
  }

  private generation(n: number): DeploymentJwtKey {
    let key = this.generations.get(n);
    if (!key) {
      key = DeploymentJwtKey.derive(this.root, n);
      this.generations.set(n, key);
    }
    return key;
  }

  get kid(): string {
    return this.generation(SIGNING_GENERATION).kid;
  }

  mint(request: DeploymentJwtRequest, nowMs: number): string {
    return this.generation(SIGNING_GENERATION).mint(request, nowMs);
  }

  /** The public keys verifiers check these tokens against. */
  jwks(): DeploymentJwks {
    return structuredClone(this.generation(SIGNING_GENERATION).jwks);
  }
}

/**
 * `signJwt`'s options, as Convex's runtime reads them. Its client spreads them into the syscall's arguments, which
 * cross as JSON (an `undefined` claim dropped, `NaN` and `Infinity` turned into `null`), and the backend parses
 * them (`crates/udf/src/deployment_jwt.rs` `mint`): `claims` an object (`{}` by default), `expiresInSeconds` a
 * finite number of at least 1, truncated to whole seconds. Each refusal is serde's message, or Convex's own.
 */
export function parseSignJwtArgs(options: unknown): { claims: Record<string, unknown>; expiresIn: number } {
  const invalid = (detail: string) =>
    new DeploymentJwtError("InvalidArguments", `Invalid arguments for auth.signJwt: ${detail}`);
  const args = JSON.parse(JSON.stringify({ ...(options as object) })) as Record<string, unknown>;
  const { claims = {}, expiresInSeconds } = args as { claims?: unknown; expiresInSeconds?: unknown };
  if (typeof claims !== "object" || claims === null || Array.isArray(claims)) {
    throw invalid(`invalid type: ${serdeType(claims)}, expected a map`);
  }
  if (expiresInSeconds === undefined) throw invalid("missing field `expiresInSeconds`");
  if (typeof expiresInSeconds !== "number") throw invalid(`invalid type: ${serdeType(expiresInSeconds)}, expected f64`);
  if (!Number.isFinite(expiresInSeconds) || expiresInSeconds < 1) {
    throw invalid("expiresInSeconds must be a number of seconds, at least 1");
  }
  return { claims: claims as Record<string, unknown>, expiresIn: Math.trunc(expiresInSeconds) };
}

/** The `iss` of a token `signer` signs under `origin`: the origin for the app, `{origin}/components/{path}` else. */
export function deploymentJwtIssuer(origin: string, signer: string): string {
  const base = origin.replace(/\/+$/, "");
  return signer === "" ? base : `${base}${COMPONENT_ISSUER_PREFIX}${signer}`;
}

/** RFC 7638 thumbprint of a P-256 public key: the required members in lexicographic order, no whitespace. */
export function jwkThumbprint(x: string, y: string): string {
  return createHash("sha256").update(`{"crv":"P-256","kty":"EC","x":"${x}","y":"${y}"}`).digest("base64url");
}

const invalidRequest = (message: string) => new DeploymentJwtError("InvalidJwtRequest", message);

/** Whether `name`'s first bytes are `prefix`, ASCII case-insensitively (on UTF-8 bytes, as Convex compares). */
function startsAsciiCaseless(name: string, prefix: string): boolean {
  const head = Buffer.from(name, "utf8").subarray(0, prefix.length);
  if (head.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    const c = head[i]!;
    const lower = c >= 0x41 && c <= 0x5a ? c + 0x20 : c;
    if (lower !== prefix.charCodeAt(i)) return false;
  }
  return true;
}

/** How serde names a JSON value's type in its errors (`invalid type: …`). */
function serdeType(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "sequence";
  switch (typeof v) {
    case "string":
      return `string ${JSON.stringify(v)}`;
    case "boolean":
      return `boolean \`${v}\``;
    case "number":
      return Number.isInteger(v) ? `integer \`${v}\`` : `floating point \`${v}\``;
    default:
      return "map";
  }
}
