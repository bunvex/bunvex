// Token verification and the identity it yields (STUDY-27 §1.2–§1.3), against an in-process issuer.
import { afterEach, describe, expect, test } from "bun:test";
import { AuthenticationError, parseAuthConfig, TokenVerifier } from "../src/index.ts";
import { type Alg, startIssuer } from "./issuer.ts";

const stops: (() => void)[] = [];
afterEach(() => {
  for (const s of stops.splice(0)) s();
});

async function issuer(opts: Parameters<typeof startIssuer>[0] = {}) {
  const i = await startIssuer(opts);
  stops.push(i.stop);
  return i;
}

const failure = async (p: Promise<unknown>) => {
  const e = await p.then(
    () => null,
    (x) => x,
  );
  if (!(e instanceof AuthenticationError)) throw new Error(`expected an AuthenticationError, got ${e}`);
  return { status: e.status, code: e.code, message: e.message };
};

describe("OIDC providers", () => {
  for (const alg of ["RS256", "EdDSA"] as Alg[])
    test(`a valid ${alg} token gives its identity`, async () => {
      const i = await issuer({ alg });
      const v = new TokenVerifier(parseAuthConfig({ providers: [{ domain: i.url, applicationID: "app" }] }));
      const token = await i.sign({
        name: "Ada",
        email: "ada@x.dev",
        email_verified: true,
        org: { id: 7 },
        jti: "j",
        nbf: 1,
      });
      const { identity, expiresAt } = await v.verify(token);
      expect(identity).toEqual({
        tokenIdentifier: `${i.url}|user-1`,
        issuer: i.url,
        subject: "user-1",
        name: "Ada",
        email: "ada@x.dev",
        emailVerified: true,
        org: { id: 7 }, // OIDC keeps nested custom claims as they are; jti / nbf are dropped
      });
      expect(expiresAt).toBeGreaterThan(Date.now() / 1000);
    });

  test("ES256 is not an OIDC algorithm (Convex: RS256 and EdDSA)", async () => {
    const i = await issuer({ alg: "ES256" });
    const v = new TokenVerifier(parseAuthConfig({ providers: [{ domain: i.url, applicationID: "app" }] }));
    expect(await failure(v.verify(await i.sign()))).toMatchObject({ status: 401, code: "Unauthenticated" });
  });

  test("wrong audience, expired, more than one audience: refused", async () => {
    const i = await issuer();
    const v = new TokenVerifier(parseAuthConfig({ providers: [{ domain: i.url, applicationID: "app" }] }));
    const expired = await i.sign({ exp: Math.floor(Date.now() / 1000) - 1 });
    expect(await failure(v.verify(expired))).toEqual({
      status: 401,
      code: "Unauthenticated",
      message:
        "Could not verify OIDC token claim. Check that the token signature is valid and the token hasn't expired.",
    });
    expect((await failure(v.verify(await i.sign({ aud: ["app", "other"] })))).code).toBe("Unauthenticated");
    // An audience that matches no provider: no provider at all.
    expect(await failure(v.verify(await i.sign({ aud: "other" })))).toMatchObject({ code: "NoAuthProvider" });
  });

  test("the provider is matched with https:// added and a trailing slash ignored", async () => {
    const i = await issuer();
    const v = new TokenVerifier(parseAuthConfig({ providers: [{ domain: `${i.url}/`, applicationID: "app" }] }));
    expect((await v.verify(await i.sign())).identity.subject).toBe("user-1");
  });

  test("discovery and JWKS are cached by Cache-Control, and an unknown kid refetches the JWKS", async () => {
    const i = await issuer({ cacheControl: "max-age=600" });
    let now = Date.now();
    const v = new TokenVerifier(parseAuthConfig({ providers: [{ domain: i.url, applicationID: "app" }] }), {
      now: () => now,
    });
    for (let n = 0; n < 3; n++) await v.verify(await i.sign());
    expect(i.hits).toEqual({ discovery: 1, jwks: 1 });
    // The provider rotates its key: the first token with the new kid refetches the JWKS (past the rate limit).
    await i.rotate("k2");
    now += 60_000;
    expect((await v.verify(await i.sign({}, { kid: "k2" }))).identity.subject).toBe("user-1");
    expect(i.hits.jwks).toBe(2);
  });

  test("without caching headers, every token fetches again", async () => {
    const i = await issuer();
    const v = new TokenVerifier(parseAuthConfig({ providers: [{ domain: i.url, applicationID: "app" }] }));
    await v.verify(await i.sign());
    await v.verify(await i.sign());
    expect(i.hits).toEqual({ discovery: 2, jwks: 2 });
  });
});

describe("custom JWT providers", () => {
  const config = (url: string, jwks: string, extra: Record<string, unknown> = {}) =>
    parseAuthConfig({
      providers: [{ type: "customJwt", issuer: url, jwks, algorithm: "ES256", applicationID: "app", ...extra }],
    });

  test("a valid token: subject, issuer, and every private claim flattened (fva dropped)", async () => {
    const i = await issuer({ alg: "ES256" });
    const v = new TokenVerifier(config(i.url, `${i.url}/jwks.json`));
    const { identity } = await v.verify(
      await i.sign({ email: "a@b.c", org: { id: 7, role: { name: "admin" } }, fva: [1, 2] }),
    );
    expect(identity).toEqual({
      tokenIdentifier: `${i.url}|user-1`,
      issuer: i.url,
      subject: "user-1",
      email: "a@b.c",
      "org.id": 7,
      "org.role.name": "admin",
    });
  });

  test("a data: URL JWKS works", async () => {
    const i = await issuer({ alg: "ES256" });
    const data = `data:application/json;base64,${Buffer.from(JSON.stringify(i.jwks())).toString("base64")}`;
    const v = new TokenVerifier(config(i.url, data));
    expect((await v.verify(await i.sign())).identity.subject).toBe("user-1");
  });

  test("Convex's errors: kid, issuer, audience, leeway, missing claims, JWKS content type", async () => {
    const i = await issuer({ alg: "ES256" });
    const v = new TokenVerifier(config(i.url, `${i.url}/jwks.json`));
    expect((await failure(v.verify(await i.sign({}, { kid: null })))).message).toBe(
      "Could not decode token. JWT may be missing a 'kid' (key ID) header.",
    );
    expect((await failure(v.verify(await i.sign({}, { kid: "nope" })))).message).toBe(
      "Could not decode token. The JWT's 'kid' (key ID) header is 'nope', does this key match any key in the provider's JWKS?",
    );
    const now = Math.floor(Date.now() / 1000);
    expect((await v.verify(await i.sign({ exp: now - 3 }))).identity.subject).toBe("user-1"); // within 5 s
    expect((await failure(v.verify(await i.sign({ exp: now - 30 })))).message).toBe(
      "Could not validate token: Token expired",
    );
    expect((await failure(v.verify(await i.sign({ exp: undefined })))).message).toBe("Missing expiry");
    const noAud = new TokenVerifier(config(i.url, `${i.url}/jwks.json`, { applicationID: undefined }));
    expect((await noAud.verify(await i.sign({ aud: undefined }))).identity.subject).toBe("user-1");
    const html = await issuer({ alg: "ES256", jwksContentType: "text/html" });
    const bad = new TokenVerifier(config(html.url, `${html.url}/jwks.json`));
    expect((await failure(bad.verify(await html.sign()))).message).toBe(
      `Invalid Content-Type 'text/html' when fetching JWKS from '${html.url}/jwks.json'. Expected 'application/json' or 'application/jwk-set+json'.`,
    );
  });

  test("a token that is not a JWT, or has no issuer", async () => {
    const v = new TokenVerifier([]);
    expect(await failure(v.verify("nope"))).toMatchObject({ status: 401, code: "InvalidAuthHeader" });
    const i = await issuer();
    expect(await failure(v.verify(await i.sign({ iss: undefined })))).toMatchObject({
      message:
        "Missing issuer claim ('iss') in JWT payload. The JWT must include an 'iss' claim that matches one of your configured auth providers.",
    });
    expect((await failure(v.verify(await i.sign()))).message).toBe(
      "No auth provider found matching the given token (no providers configured). Check bunvex/auth.config.ts.",
    );
  });
});
