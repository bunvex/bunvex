// An in-process token issuer for tests: OIDC discovery and a JWKS served over HTTP, keys generated per issuer,
// tokens signed on demand.
import { exportJWK, generateKeyPair, type JWK, SignJWT } from "jose";

export type Alg = "RS256" | "ES256" | "EdDSA";

export async function startIssuer(opts: { alg?: Alg; cacheControl?: string; jwksContentType?: string } = {}) {
  const alg = opts.alg ?? "RS256";
  let keys: { kid: string; privateKey: CryptoKey; jwk: JWK }[] = [];
  const addKey = async (kid: string) => {
    const { privateKey, publicKey } = await generateKeyPair(alg, {
      extractable: true,
      crv: alg === "EdDSA" ? "Ed25519" : undefined,
    });
    keys.push({ kid, privateKey, jwk: { ...(await exportJWK(publicKey)), kid, alg, use: "sig" } });
  };
  await addKey("k1");
  const hits = { discovery: 0, jwks: 0 };
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      const headers: Record<string, string> = {
        "content-type": path.endsWith("jwks.json") ? (opts.jwksContentType ?? "application/json") : "application/json",
      };
      if (opts.cacheControl) headers["cache-control"] = opts.cacheControl;
      if (path === "/.well-known/openid-configuration") {
        hits.discovery++;
        return new Response(JSON.stringify({ issuer: url, jwks_uri: `${url}/jwks.json` }), { headers });
      }
      if (path === "/jwks.json") {
        hits.jwks++;
        return new Response(JSON.stringify({ keys: keys.map((k) => k.jwk) }), { headers });
      }
      return new Response("not found", { status: 404 });
    },
  });
  const url = `http://127.0.0.1:${server.port}`;
  return {
    url,
    hits,
    /** A signed token; `claims` override the defaults (iss = this issuer, sub, aud "app", exp in an hour). */
    async sign(claims: Record<string, unknown> = {}, header: { kid?: string | null } = {}) {
      const key = keys.find((k) => k.kid === (header.kid ?? "k1")) ?? keys[0];
      const now = Math.floor(Date.now() / 1000);
      const jwt = new SignJWT({ iss: url, sub: "user-1", aud: "app", iat: now, exp: now + 3600, ...claims });
      jwt.setProtectedHeader({ alg, ...(header.kid === null ? {} : { kid: header.kid ?? key.kid }) });
      return jwt.sign(key.privateKey);
    },
    /** Replace the keys with a new one (a rotation). */
    async rotate(kid: string) {
      keys = [];
      await addKey(kid);
    },
    jwks: () => ({ keys: keys.map((k) => k.jwk) }),
    stop: () => server.stop(true),
  };
}
