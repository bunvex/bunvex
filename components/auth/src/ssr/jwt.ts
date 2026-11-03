// The access token as the host reads it (STUDY-202 §1.3), v2's `ssr/jwt.ts` without `jose`: the payload decoded, never
// verified (the deployment verifies; the host only decides when to refresh). This code runs in the app's server (Node,
// or an edge runtime), so it uses only web APIs.

/** The claims of an access token the host uses, each `null` when absent, of another type, or not a token at all. */
export interface DecodedAccessToken {
  /** The expiry, in seconds since the epoch. */
  exp: number | null;
  /** The subject. */
  sub: string | null;
}

// A compact JWS's payload as a JSON object, or null: three parts (a five-part JWE is not decoded), a non-empty
// base64url payload, JSON, a plain object. `jose`'s `decodeJwt` throws on the same inputs (its web build: on Node it
// reads a malformed base64url payload more leniently).
function payloadOf(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  const encoded = parts[1].replace(/-/g, "+").replace(/_/g, "/").replace(/\s/g, "");
  let text: string;
  try {
    const binary = atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "="));
    text = new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return null;
  }
  return typeof payload === "object" && payload !== null && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : null;
}

/** Read an access token's expiry and subject, without verifying it. */
export function decodeAccessToken(token: string): DecodedAccessToken {
  const claims = payloadOf(token);
  return {
    exp: typeof claims?.exp === "number" ? claims.exp : null,
    sub: typeof claims?.sub === "string" ? claims.sub : null,
  };
}

/**
 * Whether an access token expires within `skewSeconds` (10 by default) of `nowMs`. A token without an expiry, or that is
 * not a token, counts as expiring.
 */
export function isTokenExpiring(token: string, skewSeconds = 10, nowMs: number = Date.now()): boolean {
  const { exp } = decodeAccessToken(token);
  if (exp === null) return true;
  return exp * 1000 - nowMs <= skewSeconds * 1000;
}
