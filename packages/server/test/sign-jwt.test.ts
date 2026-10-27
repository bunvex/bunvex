// `ctx.auth.signJwt` and the deployment's JWKS (STUDY-192 §3.2–§3.3): a mutation signs with the deployment's key,
// the `iss` the cloud URL (the canonical one once set), `iat` the mutation's own time; queries and actions have no
// `signJwt`, a mutation an action runs does; every refusal is thrown in the mutation; and `/.well-known/jwks.json`
// serves the key that verifies the tokens, cacheable, under the API's CORS.
import { afterEach, describe, expect, test } from "bun:test";
import { createPublicKey, verify } from "node:crypto";
import { defineSchema, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { setCanonicalUrl } from "../src/canonical-urls.ts";
import { action, Functions, mutation, query } from "../src/functions.ts";
import { createServer } from "../src/server.ts";

const SECRET = "4361726e697461732c206c69746572616c6c79206d65616e7320636172726f74";
const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
});

type Signed = { token: string; now: number };
async function setup() {
  const engine = await new Engine(defineSchema({}), await MemoryPersistence.open(null, { durable: false }), {
    instanceName: "sign-jwt-test",
    instanceSecret: SECRET,
  }).init();
  stops.push(() => engine.close());
  const functions = new Functions(engine).register("m", {
    sign: mutation(async ({ auth }, { claims, expiresInSeconds }: { claims?: never; expiresInSeconds: number }) => ({
      token: await auth.signJwt({ claims, expiresInSeconds }),
      now: Date.now(),
    })),
    signCaught: mutation(async ({ auth }, options: never) => {
      try {
        return { token: await auth.signJwt(options) };
      } catch (e) {
        return { name: (e as Error).name, message: (e as Error).message };
      }
    }),
    queryHasIt: query(async ({ auth }) => typeof (auth as { signJwt?: unknown }).signJwt),
    actionHasIt: action(async ({ auth }) => typeof (auth as { signJwt?: unknown }).signJwt),
    viaAction: action(async ({ runMutation }) => runMutation("m:sign" as never, { expiresInSeconds: 60 } as never)),
  });
  functions.builtinEnv = { BUNVEX_CLOUD_URL: "http://127.0.0.1:3210", BUNVEX_SITE_URL: "http://127.0.0.1:3211" };
  return { engine, functions };
}

const decode = (token: string) => {
  const [h, p] = token.split(".") as [string, string];
  return {
    header: JSON.parse(Buffer.from(h, "base64url").toString()),
    payload: JSON.parse(Buffer.from(p, "base64url").toString()),
  };
};
/** Whether `jwks`' key verifies the token. */
function verifies(token: string, jwks: { keys: { kty: string; crv: string; x: string; y: string }[] }) {
  const [h, p, s] = token.split(".") as [string, string, string];
  const { kty, crv, x, y } = jwks.keys[0]!;
  const key = createPublicKey({ key: { kty, crv, x, y }, format: "jwk" });
  return verify("sha256", Buffer.from(`${h}.${p}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url"));
}

describe("ctx.auth.signJwt", () => {
  test("a mutation signs: iss the cloud URL, iat its own time, exp after the lifetime, the deployment's kid", async () => {
    const { engine, functions } = await setup();
    const { token, now } = (await functions.runMutation("m:sign", {
      claims: { sub: "user|1", role: "admin" },
      expiresInSeconds: 90.9,
    })) as Signed;
    const { header, payload } = decode(token);
    expect(header).toEqual({ alg: "ES256", typ: "JWT", kid: engine.deploymentJwtKeys.kid });
    expect(payload).toEqual({
      sub: "user|1",
      role: "admin",
      iss: "http://127.0.0.1:3210",
      iat: Math.floor(now / 1000),
      exp: Math.floor(now / 1000) + 90,
    });
    expect(verifies(token, engine.deploymentJwtKeys.jwks())).toBe(true);
  });

  test("the canonical cloud URL, once set, is the iss", async () => {
    const { engine, functions } = await setup();
    await engine.mutation((db) => setCanonicalUrl(db, "bunvexCloud", "https://api.example.com/"));
    const { token } = (await functions.runMutation("m:sign", { expiresInSeconds: 60 })) as Signed;
    expect(decode(token).payload.iss).toBe("https://api.example.com");
  });

  test("queries and actions have no signJwt; a mutation an action runs has it", async () => {
    const { functions } = await setup();
    expect(await functions.runQuery("m:queryHasIt", {})).toBe("undefined");
    expect(await functions.runAction("m:actionHasIt", {})).toBe("undefined");
    const { token } = (await functions.runAction("m:viaAction", {})) as Signed;
    expect(decode(token).payload.iss).toBe("http://127.0.0.1:3210");
  });

  test("refusals are thrown in the mutation, as errors with the runtime's messages", async () => {
    const { functions } = await setup();
    const caught = (options: unknown) => functions.runMutation("m:signCaught", options as never);
    expect(await caught({ claims: { iss: "me" }, expiresInSeconds: 60 })).toEqual({
      name: "Error",
      message: "The 'iss' claim is set by the deployment and can't be provided",
    });
    expect(await caught({ claims: { cvxRole: 1 }, expiresInSeconds: 60 })).toEqual({
      name: "Error",
      message: "The 'cvxRole' claim can't be provided: claim names starting with 'convex' or 'cvx' are reserved",
    });
    expect(await caught({ expiresInSeconds: 3601 })).toEqual({
      name: "Error",
      message: "expiresIn must be between 1 second and 3600 seconds",
    });
    expect(await caught({ expiresInSeconds: 0.5 })).toEqual({
      name: "Error",
      message: "Invalid arguments for auth.signJwt: expiresInSeconds must be a number of seconds, at least 1",
    });
    expect(await caught({})).toEqual({
      name: "Error",
      message: "Invalid arguments for auth.signJwt: missing field `expiresInSeconds`",
    });
  });

  test("DEPLOYMENT_JWT_MAX_LIFETIME_SECONDS lowers the longest lifetime", async () => {
    const { functions } = await setup();
    functions.jwtMaxLifetimeSeconds = 120;
    expect(await functions.runMutation("m:signCaught", { expiresInSeconds: 121 } as never)).toEqual({
      name: "Error",
      message: "expiresIn must be between 1 second and 120 seconds",
    });
  });
});

describe("GET /.well-known/jwks.json", () => {
  test("the key that verifies the tokens, cacheable for 300 s, no auth, under the API's CORS; GET only", async () => {
    const { engine, functions } = await setup();
    const server = createServer({ engine, functions, port: 0, hostname: "127.0.0.1" });
    await server.codeReady;
    stops.push(() => server.server.stop(true));
    const url = `http://127.0.0.1:${server.server.port}/.well-known/jwks.json`;
    const res = await fetch(url, { headers: { origin: "https://app.example.com" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    expect(res.headers.get("access-control-allow-origin")).toBe("https://app.example.com");
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
    const jwks = (await res.json()) as { keys: { kty: string; crv: string; x: string; y: string }[] };
    expect(jwks).toEqual(engine.deploymentJwtKeys.jwks());
    const { token } = (await functions.runMutation("m:sign", { expiresInSeconds: 60 })) as Signed;
    expect(verifies(token, jwks)).toBe(true);
    expect((await fetch(url, { method: "POST" })).status).toBe(405);
    const preflight = await fetch(url, { method: "OPTIONS", headers: { origin: "https://app.example.com" } });
    expect(preflight.status).toBe(200);
  });
});
