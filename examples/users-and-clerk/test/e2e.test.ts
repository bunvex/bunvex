// The Clerk example end to end (STUDY-90). Clerk is replaced by a local OpenID Connect issuer (discovery and
// JWKS over HTTP, tokens signed here) that the deployment trusts through `auth.config.ts`; the tokens are what
// Clerk's "bunvex" JWT template signs: `aud: "bunvex"`, the user's id as `sub`, and their name.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import { BunvexHttpClient } from "bunvex/browser";
import { build, type Deployment, deploy, until } from "bunvex-examples-harness";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { api } from "../bunvex/_generated/api.js";

const DIR = resolve(import.meta.dir, "..");
const { privateKey, publicKey } = await generateKeyPair("RS256");
const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
const issuer = Bun.serve({
  port: 0,
  fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/.well-known/openid-configuration")
      return Response.json({ issuer: ISSUER, jwks_uri: `${ISSUER}/.well-known/jwks.json` });
    if (path === "/.well-known/jwks.json") return Response.json({ keys: [jwk] });
    return new Response("not found", { status: 404 });
  },
});
const ISSUER = `http://127.0.0.1:${issuer.port}`;

/** A token as Clerk's "bunvex" template signs it. */
const token = (sub: string, name: string, aud = "bunvex") =>
  new SignJWT({ name })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(ISSUER)
    .setSubject(sub)
    .setAudience(aud)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(privateKey);

let d: Deployment;
const as = async (sub: string, name: string, aud?: string) => {
  const c = new BunvexHttpClient(d.url, { logger: false });
  c.setAuth(await token(sub, name, aud));
  return c;
};
beforeAll(async () => {
  d = await deploy(DIR, { env: { CLERK_JWT_ISSUER_DOMAIN: ISSUER } });
});
afterAll(async () => {
  await d?.stop();
  issuer.stop(true);
});

test("signed out: no user is stored and no message is sent", async () => {
  await expect(d.http.mutation(api.users.store, {})).rejects.toThrow("users:store needs a signed-in user");
  await expect(d.http.mutation(api.messages.send, { body: "hi" })).rejects.toThrow("Sign in to send messages");
});

test("a signed-in user is stored once, and their messages carry their name, live", async () => {
  let latest: { author: string; body: string; user: string }[] | undefined;
  d.client().onUpdate(api.messages.list, {}, (r) => {
    latest = r;
  });
  await until(() => latest, "the first result");
  const ada = await as("user_ada", "Ada");
  // Signed in but not stored yet: the page stores the user first.
  await expect(ada.mutation(api.messages.send, { body: "too early" })).rejects.toThrow("Sign in to send messages");
  const adaId = await ada.mutation(api.users.store, {});
  expect(await ada.mutation(api.users.store, {})).toBe(adaId);
  await ada.mutation(api.messages.send, { body: "hello" });
  const grace = await as("user_grace", "Grace");
  const graceId = await grace.mutation(api.users.store, {});
  expect(graceId).not.toBe(adaId);
  await grace.mutation(api.messages.send, { body: "hi Ada" });
  const both = await until(() => latest?.length === 2 && latest, "both messages");
  expect(both.map((m) => [m.author, m.body, m.user])).toEqual([
    ["Ada", "hello", adaId],
    ["Grace", "hi Ada", graceId],
  ]);
  // A new name in the token: storing again updates the user, and every message shows it.
  await (await as("user_ada", "Ada Lovelace")).mutation(api.users.store, {});
  await until(() => latest?.[0]?.author === "Ada Lovelace", "the new name");
});

test("a token for another audience is refused", async () => {
  const other = await as("user_eve", "Eve", "another-app");
  await expect(other.mutation(api.users.store, {})).rejects.toThrow();
});

test("the front end typechecks and builds", async () => {
  await build(DIR);
});
