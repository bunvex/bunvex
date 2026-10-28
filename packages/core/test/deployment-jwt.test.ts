// The deployment's JWT keys and minting (STUDY-192 §3.1, §5): the key derived from a fixed secret, the thumbprint,
// a token's header, claims and ES256 signature checked against the JWKS, and every refusal of Convex's
// `mint` and `DeploymentJwtKey::mint`, in Convex's order, with bunvex's words where Convex names itself (DV-578).
import { describe, expect, test } from "bun:test";
import { createHash, createPublicKey, verify } from "node:crypto";
import {
  DEPLOYMENT_JWT_MAX_SIZE,
  DeploymentJwtError,
  DeploymentJwtKeys,
  deploymentJwtIssuer,
  instanceSecretBytes,
  jwkThumbprint,
  parseSignJwtArgs,
} from "../src/index.ts";

const SECRET = instanceSecretBytes("4361726e697461732c206c69746572616c6c79206d65616e7320636172726f74");
const keys = DeploymentJwtKeys.fromSecret(SECRET);
const NOW = 1_765_432_101_234;
const base = {
  origin: "https://happy-otter-123.example.com",
  signer: "",
  claims: {},
  expiresIn: 60,
  maxLifetime: 3600,
};

/** A token's three parts, decoded. */
function decode(token: string) {
  const [h, p, s] = token.split(".") as [string, string, string];
  return {
    header: JSON.parse(Buffer.from(h, "base64url").toString()),
    payload: JSON.parse(Buffer.from(p, "base64url").toString()),
    payloadText: Buffer.from(p, "base64url").toString(),
    signature: Buffer.from(s, "base64url"),
    input: `${h}.${p}`,
  };
}
/** Whether the JWKS's key verifies the token's ES256 signature. */
function verifies(token: string): boolean {
  const { input, signature } = decode(token);
  const jwk = keys.jwks().keys[0]!;
  const key = createPublicKey({ key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, format: "jwk" });
  return verify("sha256", Buffer.from(input), { key, dsaEncoding: "ieee-p1363" }, signature);
}
type Outcome = { code?: string; message?: string; other?: string } | null;
const refusal = (fn: () => unknown): Outcome => {
  try {
    fn();
  } catch (e) {
    return e instanceof DeploymentJwtError ? { code: e.code, message: e.message } : { other: String(e) };
  }
  return null;
};

describe("the keys", () => {
  test("a pure function of the secret: one P-256 signing key, its kid the RFC 7638 thumbprint", () => {
    const jwks = keys.jwks();
    expect(jwks.keys).toHaveLength(1);
    const jwk = jwks.keys[0]!;
    expect(Object.keys(jwk)).toEqual(["use", "alg", "kid", "kty", "crv", "x", "y"]);
    expect(jwk).toMatchObject({ kty: "EC", crv: "P-256", use: "sig", alg: "ES256" });
    expect(Buffer.from(jwk.x, "base64url")).toHaveLength(32);
    expect(Buffer.from(jwk.y, "base64url")).toHaveLength(32);
    expect(jwk.kid).toBe(
      createHash("sha256").update(`{"crv":"P-256","kty":"EC","x":"${jwk.x}","y":"${jwk.y}"}`).digest("base64url"),
    );
    expect(jwk.kid).toBe(jwkThumbprint(jwk.x, jwk.y));
    // The same secret, the same keys; another secret, others.
    expect(DeploymentJwtKeys.fromSecret(SECRET).jwks()).toEqual(jwks);
    expect(DeploymentJwtKeys.fromSecret(instanceSecretBytes("00".repeat(32))).kid).not.toBe(keys.kid);
  });

  test("the key a fixed secret derives (pinned; the differential test checks it against Convex's)", () => {
    expect(keys.jwks()).toMatchSnapshot();
  });
});

describe("a token", () => {
  test("header, claims in the caller's order then iss, iat, exp, and a signature the JWKS verifies", () => {
    const token = keys.mint({ ...base, claims: { sub: "user|1", z: 1, a: [true, null] } }, NOW);
    const { header, payload, payloadText, signature } = decode(token);
    expect(header).toEqual({ alg: "ES256", typ: "JWT", kid: keys.kid });
    expect(payloadText).toBe(
      `{"sub":"user|1","z":1,"a":[true,null],"iss":"https://happy-otter-123.example.com","iat":1765432101,"exp":1765432161}`,
    );
    expect(payload.iat).toBe(Math.floor(NOW / 1000));
    expect(signature).toHaveLength(64);
    expect(verifies(token)).toBe(true);
    // Random nonces: the same claims sign differently, and both verify.
    const again = keys.mint({ ...base, claims: { sub: "user|1", z: 1, a: [true, null] } }, NOW);
    expect(again).not.toBe(token);
    expect(verifies(again)).toBe(true);
    // A changed payload does not verify.
    const [h, , s] = token.split(".");
    const forged = `${h}.${Buffer.from(JSON.stringify({ ...payload, sub: "user|2" })).toString("base64url")}.${s}`;
    expect(verifies(forged)).toBe(false);
  });

  test("the issuer: the origin for the app, under /components/ for a component, a trailing slash dropped", () => {
    expect(deploymentJwtIssuer("https://a.example.com/", "")).toBe("https://a.example.com");
    expect(deploymentJwtIssuer("https://a.example.com", "auth")).toBe("https://a.example.com/components/auth");
    expect(deploymentJwtIssuer("https://a.example.com//", "a/b")).toBe("https://a.example.com/components/a/b");
    const token = keys.mint({ ...base, signer: "auth" }, NOW);
    expect(decode(token).payload.iss).toBe("https://happy-otter-123.example.com/components/auth");
  });
});

describe("refusals, in Convex's order", () => {
  const mint = (claims: Record<string, unknown>, expiresIn = 60) =>
    refusal(() => keys.mint({ ...base, claims, expiresIn }, NOW));

  test("iss, iat, exp: set by the deployment", () => {
    for (const name of ["iss", "iat", "exp"]) {
      expect(mint({ [name]: 1 })).toEqual({
        code: "InvalidJwtRequest",
        message: `The '${name}' claim is set by the deployment and can't be provided`,
      });
    }
    // Before the prefix rule.
    expect(mint({ convexA: 1, iat: 1 })?.message).toContain("'iat'");
  });

  test("names starting with bunvex or bvx, in any ASCII casing (Convex reserves convex and cvx, DV-578)", () => {
    for (const name of ["bunvex", "BUNVEXbar", "BvXfoo", "bvx_", "Bunvex.id"]) {
      expect(mint({ [name]: 1 })).toEqual({
        code: "InvalidJwtRequest",
        message: `The '${name}' claim can't be provided: claim names starting with 'bunvex' or 'bvx' are reserved`,
      });
    }
    // Not a prefix, or Convex's prefixes: allowed.
    for (const name of ["bv", "xbvx", "bunve", "ƀvx", "convexFoo", "CvXfoo"]) expect(mint({ [name]: 1 })).toBeNull();
  });

  test("sub: a non-empty string", () => {
    for (const sub of ["", 1, null, ["a"], { a: 1 }]) {
      expect(mint({ sub })).toEqual({
        code: "InvalidJwtRequest",
        message: "The 'sub' claim must be a non-empty string",
      });
    }
    expect(mint({ sub: "x" })).toBeNull();
  });

  test("nbf: reserved; jti: allowed", () => {
    expect(mint({ nbf: 1 })).toEqual({
      code: "InvalidJwtRequest",
      message: "The 'nbf' claim is reserved by the deployment and can't be provided",
    });
    expect(mint({ jti: "x" })).toBeNull();
  });

  test("the lifetime: 1 second to the maximum", () => {
    const outOfRange = { code: "InvalidJwtRequest", message: "expiresIn must be between 1 second and 3600 seconds" };
    expect(mint({}, 0)).toEqual(outOfRange);
    expect(mint({}, 3601)).toEqual(outOfRange);
    expect(mint({}, 1)).toBeNull();
    expect(mint({}, 3600)).toBeNull();
  });

  test("the size: 8000 bytes at most", () => {
    // The length a padding gives, or Infinity once it is refused.
    const sizeWith = (n: number) => {
      try {
        return keys.mint({ ...base, claims: { pad: "x".repeat(n) } }, NOW).length;
      } catch {
        return Number.POSITIVE_INFINITY;
      }
    };
    const at = sizeWith(0);
    // base64url grows by 4 characters per 3 bytes: find the largest padding that fits, then one past it.
    let n = Math.floor(((DEPLOYMENT_JWT_MAX_SIZE - at) * 3) / 4);
    while (sizeWith(n + 1) <= DEPLOYMENT_JWT_MAX_SIZE) n++;
    while (sizeWith(n) > DEPLOYMENT_JWT_MAX_SIZE) n--;
    expect(sizeWith(n)).toBeLessThanOrEqual(DEPLOYMENT_JWT_MAX_SIZE);
    const over = mint({ pad: "x".repeat(n + 3) });
    expect(over?.code).toBe("InvalidJwtRequest");
    expect(over?.message).toMatch(/^The token is 800\d bytes, over the 8000 byte limit$/);
  });
});

describe("the options, as the runtime reads them", () => {
  const parse = (options: unknown): unknown => {
    try {
      return parseSignJwtArgs(options);
    } catch (e) {
      return { code: (e as DeploymentJwtError).code, message: (e as Error).message };
    }
  };
  const invalid = (detail: string) => ({
    code: "InvalidArguments",
    message: `Invalid arguments for auth.signJwt: ${detail}`,
  });

  test("claims default to {}; the lifetime truncates to whole seconds", () => {
    expect(parse({ expiresInSeconds: 60 })).toEqual({ claims: {}, expiresIn: 60 });
    expect(parse({ expiresInSeconds: 1.9 })).toEqual({ claims: {}, expiresIn: 1 });
    expect(parse({ claims: { a: 1, b: undefined }, expiresInSeconds: 2 })).toEqual({ claims: { a: 1 }, expiresIn: 2 });
  });

  test("a lifetime below 1, or not finite (sent as null), or missing, or not a number", () => {
    expect(parse({ expiresInSeconds: 0.5 })).toEqual(
      invalid("expiresInSeconds must be a number of seconds, at least 1"),
    );
    expect(parse({ expiresInSeconds: -1 })).toEqual(
      invalid("expiresInSeconds must be a number of seconds, at least 1"),
    );
    expect(parse({ expiresInSeconds: Number.NaN })).toEqual(invalid("invalid type: null, expected f64"));
    expect(parse({ expiresInSeconds: Number.POSITIVE_INFINITY })).toEqual(invalid("invalid type: null, expected f64"));
    expect(parse({})).toEqual(invalid("missing field `expiresInSeconds`"));
    expect(parse(undefined)).toEqual(invalid("missing field `expiresInSeconds`"));
    expect(parse({ expiresInSeconds: "60" })).toEqual(invalid('invalid type: string "60", expected f64'));
  });

  test("claims that are not an object", () => {
    expect(parse({ claims: null, expiresInSeconds: 1 })).toEqual(invalid("invalid type: null, expected a map"));
    expect(parse({ claims: [1], expiresInSeconds: 1 })).toEqual(invalid("invalid type: sequence, expected a map"));
    expect(parse({ claims: "x", expiresInSeconds: 1 })).toEqual(invalid('invalid type: string "x", expected a map'));
  });
});
