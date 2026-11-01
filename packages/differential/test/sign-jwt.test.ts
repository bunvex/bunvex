// `ctx.auth.signJwt` and `/.well-known/jwks.json` (STUDY-192) on Convex's backend (the oracle) and on bunvex's,
// both started with the same instance secret:
// - the JWKS is byte for byte the same (the keys are a function of the secret), with the same `Cache-Control`;
// - a token either signs verifies with the other's JWKS, and has the same header and claims (the `iss` each backend's
//   own origin, under `/components/signer` for the component);
// - every refusal is the same, caught and uncaught, apart from the words where Convex names itself and the reserved
//   claim-name prefixes, `bunvex` and `bvx` where Convex has `convex` and `cvx` (DV-578);
// - neither a query nor an action has `signJwt`.
// Local only: skipped, with a note, when Convex's backend is not there.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createPublicKey, randomBytes, verify } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type Backend, ORACLE_BIN, startBunvex, startConvex } from "../harness/backends.ts";

const ready = existsSync(ORACLE_BIN);
if (!ready) console.warn(`sign-jwt: skipped, no Convex backend at ${ORACLE_BIN} (set CONVEX_BACKEND_BIN)`);

const APP = resolve(import.meta.dir, "../sign-jwt-app");
const NAME = "sign-jwt-test";
const SECRET = randomBytes(32).toString("hex");
const dirs: string[] = [];

/** The component's directory beside the app's files; for bunvex, its own config file names and imports. */
function prepare(project: string, dir: "convex" | "bunvex") {
  const fns = join(project, dir);
  cpSync(join(APP, "signer"), join(fns, "signer"), { recursive: true });
  if (dir === "convex") return;
  for (const d of [fns, join(fns, "signer")]) {
    for (const name of readdirSync(d)) {
      if (!name.endsWith(".ts")) continue;
      const path = join(d, name);
      writeFileSync(
        path,
        readFileSync(path, "utf8")
          .replaceAll('"convex/server"', '"@bunvex/server"')
          .replaceAll('"convex/values"', '"@bunvex/values"')
          .replaceAll("./signer/convex.config", "./signer/bunvex.config"),
      );
    }
    renameSync(join(d, "convex.config.ts"), join(d, "bunvex.config.ts"));
  }
}
/** A store of its own for each backend, with the one secret. */
const store = () => {
  const dir = mkdtempSync(join(tmpdir(), "sign-jwt-"));
  dirs.push(dir);
  return { dir, name: NAME, secret: SECRET };
};

let convex: Backend;
let bunvex: Backend;
beforeAll(async () => {
  if (!ready) return;
  [convex, bunvex] = await Promise.all([
    startConvex({ app: APP, prepare, store: store() }),
    startBunvex({ app: APP, prepare, store: store() }),
  ]);
}, 300_000);
afterAll(async () => {
  await Promise.all([convex?.stop(), bunvex?.stop()]);
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const value = async (
  b: Backend,
  kind: "query" | "mutation" | "action",
  path: string,
  args: Record<string, unknown> = {},
) => {
  const r = await b.call(kind, path, args);
  if (!r.ok) throw new Error(`${b.name}: call failed: ${JSON.stringify(r.body)}`);
  return (r.body as { value: unknown }).value;
};
const jwksOf = async (b: Backend) => {
  const res = await fetch(`${b.url}/.well-known/jwks.json`);
  return { status: res.status, cacheControl: res.headers.get("cache-control"), text: await res.text() };
};
const parts = (token: string) => {
  const [h, p] = token.split(".") as [string, string];
  return {
    header: JSON.parse(Buffer.from(h, "base64url").toString()),
    payload: JSON.parse(Buffer.from(p, "base64url").toString()),
  };
};
function verifies(token: string, jwksText: string): boolean {
  const [h, p, s] = token.split(".") as [string, string, string];
  const { kty, crv, x, y } = JSON.parse(jwksText).keys[0];
  const key = createPublicKey({ key: { kty, crv, x, y }, format: "jwk" });
  return verify("sha256", Buffer.from(`${h}.${p}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url"));
}
/** Convex's words where it names itself, as bunvex's (DV-578). */
const inBunvexWords = (x: unknown) =>
  JSON.parse(
    JSON.stringify(x)
      .replaceAll("set by Convex", "set by the deployment")
      .replaceAll("reserved by Convex", "reserved by the deployment"),
  );
/** A backend's own origin, replaced: the claims are otherwise the same. */
const withoutOrigin = (b: Backend, payload: Record<string, unknown>) => ({
  ...payload,
  iss: String(payload.iss).replace(b.url.replace(/\/$/, ""), "<origin>"),
});

describe.skipIf(!ready)("signJwt and the JWKS: Convex and bunvex with the same instance secret", () => {
  test("the JWKS is the same, byte for byte, with the same cache header", async () => {
    const [c, x] = [await jwksOf(convex), await jwksOf(bunvex)];
    expect(c.status).toBe(200);
    expect(x).toEqual(c);
  });

  test("a token: the same header and claims, and each verifies with the other's JWKS", async () => {
    const options = { claims: { sub: "user|1", role: "admin", n: [1, 2.5, null] }, expiresInSeconds: 90.9 };
    const c = (await value(convex, "mutation", "jwt:sign", { options })) as { token: string; now: number };
    const x = (await value(bunvex, "mutation", "jwt:sign", { options })) as { token: string; now: number };
    const [cp, xp] = [parts(c.token), parts(x.token)];
    expect(xp.header).toEqual(cp.header);
    // The claims' order too: the caller's, then iss, iat, exp.
    expect(Object.keys(xp.payload)).toEqual(Object.keys(cp.payload));
    const relative = (p: Record<string, unknown>, now: number) => ({
      ...p,
      iat: Number(p.iat) - Math.floor(now / 1000),
      exp: Number(p.exp) - Number(p.iat),
    });
    expect(relative(withoutOrigin(bunvex, xp.payload), x.now)).toEqual(
      relative(withoutOrigin(convex, cp.payload), c.now),
    );
    expect(withoutOrigin(convex, cp.payload).iss).toBe("<origin>");
    const [cj, xj] = [(await jwksOf(convex)).text, (await jwksOf(bunvex)).text];
    expect(verifies(c.token, xj)).toBe(true);
    expect(verifies(x.token, cj)).toBe(true);
  });

  test("a component's token: its iss under /components/signer", async () => {
    const c = parts((await value(convex, "mutation", "jwt:signInComponent")) as string).payload;
    const x = parts((await value(bunvex, "mutation", "jwt:signInComponent")) as string).payload;
    expect(withoutOrigin(convex, c).iss).toBe("<origin>/components/signer");
    expect(withoutOrigin(bunvex, x).iss).toBe("<origin>/components/signer");
  });

  test("the refusals, caught in the mutation and uncaught", async () => {
    const cases: unknown[] = [
      { claims: { iss: "x" }, expiresInSeconds: 60 },
      { claims: { exp: 1 }, expiresInSeconds: 60 },
      { claims: { sub: "" }, expiresInSeconds: 60 },
      { claims: { sub: 7 }, expiresInSeconds: 60 },
      { claims: { nbf: 1 }, expiresInSeconds: 60 },
      { expiresInSeconds: 0.5 },
      { expiresInSeconds: 3601 },
      { expiresInSeconds: "60" },
      { claims: [1], expiresInSeconds: 60 },
      { claims: null, expiresInSeconds: 60 },
      {},
      { claims: { pad: "x".repeat(9000) }, expiresInSeconds: 60 },
    ];
    for (const options of cases) {
      const c = inBunvexWords(await value(convex, "mutation", "jwt:sign", { options }));
      const x = await value(bunvex, "mutation", "jwt:sign", { options });
      expect({ options, bunvex: x }).toEqual({ options, bunvex: c });
      const cu = await convex.call("mutation", "jwt:signUncaught", { options });
      const xu = await bunvex.call("mutation", "jwt:signUncaught", { options });
      // The whole message, its request id (each call's own) replaced.
      const message = (r: { body: unknown }) =>
        String((r.body as { errorMessage?: string }).errorMessage ?? "").replace(
          /\[Request ID: [0-9a-f]+\]/,
          "[Request ID: <id>]",
        );
      expect({ options, bunvex: message(xu) }).toEqual({ options, bunvex: inBunvexWords(message(cu)) });
    }
  }, 120_000);

  test("the reserved prefixes: each refuses its own and signs the other's (DV-578)", async () => {
    const signs = (r: unknown) => typeof (r as { token?: unknown }).token === "string";
    for (const name of ["CvXfoo", "convexId"]) {
      const options = { claims: { [name]: 1 }, expiresInSeconds: 60 };
      expect(signs(await value(bunvex, "mutation", "jwt:sign", { options }))).toBe(true);
      expect(await value(convex, "mutation", "jwt:sign", { options })).toMatchObject({
        message: `The '${name}' claim can't be provided: claim names starting with 'convex' or 'cvx' are reserved`,
      });
    }
    for (const name of ["BvXfoo", "bunvexId"]) {
      const options = { claims: { [name]: 1 }, expiresInSeconds: 60 };
      expect(signs(await value(convex, "mutation", "jwt:sign", { options }))).toBe(true);
      expect(await value(bunvex, "mutation", "jwt:sign", { options })).toMatchObject({
        message: `The '${name}' claim can't be provided: claim names starting with 'bunvex' or 'bvx' are reserved`,
      });
    }
  });

  test("neither a query nor an action has signJwt", async () => {
    for (const [kind, path] of [
      ["query", "jwt:queryHasIt"],
      ["action", "jwt:actionHasIt"],
    ] as const) {
      expect(await value(bunvex, kind, path)).toBe(await value(convex, kind, path));
    }
  });
});
