// `t.jwks()`, convex-test's (0.0.65): the public keys that verify `ctx.auth.signJwt`'s tokens, the app's and its
// component's, in-process and under the process sandbox (where the host signs, DV-579). Each test deployment signs
// with a key of its own, as each convex-test instance does.
import { afterEach, describe, expect, test } from "bun:test";
import { createPublicKey, verify } from "node:crypto";
import { join } from "node:path";
import { anyApi } from "@bunvex/server";
import { bunvexTest, type DeploymentJwks, type TestBunvex } from "../src/index.ts";

const APP = join(import.meta.dir, "fixtures", "app-with-component");
const open: TestBunvex[] = [];
const saved = {
  sandbox: process.env.BUNVEX_FUNCTION_SANDBOX,
  isolation: process.env.BUNVEX_FUNCTION_SANDBOX_ISOLATION,
};
afterEach(async () => {
  for (const t of open.splice(0)) await t.close();
  for (const [name, value] of [
    ["BUNVEX_FUNCTION_SANDBOX", saved.sandbox],
    ["BUNVEX_FUNCTION_SANDBOX_ISOLATION", saved.isolation],
  ] as const)
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
});

const deployment = () => {
  const t = bunvexTest({ cwd: APP });
  open.push(t);
  return t;
};
const tokensOf = async (t: TestBunvex) =>
  (await t.mutation(anyApi.visits.tokens)) as { app: string; component: string };

/** Whether `token` is signed by the JWKS key its header's `kid` names (ES256, the signature r ‖ s). */
function verifies(token: string, jwks: DeploymentJwks): boolean {
  const [header, payload, signature] = token.split(".") as [string, string, string];
  const { alg, kid } = JSON.parse(Buffer.from(header, "base64url").toString());
  const jwk = jwks.keys.find((k) => k.kid === kid);
  if (alg !== "ES256" || !jwk) return false;
  return verify(
    "sha256",
    Buffer.from(`${header}.${payload}`),
    { key: createPublicKey({ key: jwk, format: "jwk" }), dsaEncoding: "ieee-p1363" },
    Buffer.from(signature, "base64url"),
  );
}

describe.each(["in-process", "process sandbox"] as const)("t.jwks(), %s", (mode) => {
  test("one ES256 key, which verifies the app's token and its component's", async () => {
    if (mode === "process sandbox") {
      process.env.BUNVEX_FUNCTION_SANDBOX = "process";
      process.env.BUNVEX_FUNCTION_SANDBOX_ISOLATION = "none";
    }
    const t = deployment();
    const { app, component } = await tokensOf(t);
    const jwks = await t.jwks();
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]).toMatchObject({ kty: "EC", crv: "P-256", alg: "ES256", use: "sig" });
    expect(verifies(app, jwks)).toBe(true);
    expect(verifies(component, jwks)).toBe(true);
    // A token whose payload changed does not.
    const [h, , s] = app.split(".");
    const forged = Buffer.from(JSON.stringify({ sub: "someone else" })).toString("base64url");
    expect(verifies(`${h}.${forged}.${s}`, jwks)).toBe(false);
  }, 30_000);
});

test("each test deployment signs with its own key: its JWKS does not verify another's tokens", async () => {
  const [a, b] = [deployment(), deployment()];
  const [ja, jb] = [await a.jwks(), await b.jwks()];
  expect(ja.keys[0]!.kid).not.toBe(jb.keys[0]!.kid);
  const { app } = await tokensOf(a);
  expect(verifies(app, ja)).toBe(true);
  expect(verifies(app, jb)).toBe(false);
  // The same deployment answers the same keys every time.
  expect(await a.jwks()).toEqual(ja);
}, 30_000);
