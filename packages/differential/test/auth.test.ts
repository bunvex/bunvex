// Built-in auth (STUDY-201 4d, STUDY-208) on Convex's backend (the oracle) with Convex Auth 2.0.0 at the pin (`@convex-dev/auth`, built
// from the reference clone by harness/convex-auth.ts) and on bunvex's with `@bunvex/auth`: the same app (auth-app/) makes
// the same calls on both, signed-in ones with the access tokens each issued, verified by each deployment against its
// own JWKS through `auth.config.ts`. It compares, normalized (ids by their first appearance, tokens, hashes and times by
// their form):
// - every result: sign-up and sign-in, their refusals in order, the rate limit, refresh (rotation, a lost answer's
//   retry, a spent token's reuse revoking the session), `changePassword`'s arms, anonymous sign-in, sign-out;
// - the caller's user (`getAuthUserId`) and `isAuthenticated`, live and after the session is gone;
// - the access token: its header's fields, its claims (`aud` is bunvex's, DV-576), its lifetime, `iss` under
//   `/components/auth` and `sub` the session;
// - every row of the core's, the method components' and the app's tables at the end, once the scheduled erasure of the
//   deleted sessions' refresh tokens has run;
// - a password hash Convex's side stored verifies with bunvex's verifier.
// Local only: skipped, with a note, without Convex's backend or a convex-auth clone to build the pin from.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { argon2, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { type Backend, ORACLE_BIN, startAll, startBunvex, startConvex } from "../harness/backends.ts";
import { authAppPreparer, convexAuthModules } from "../harness/convex-auth.ts";

const pin = existsSync(ORACLE_BIN) ? convexAuthModules() : { missing: `no Convex backend at ${ORACLE_BIN}` };
const ready = "modules" in pin;
if (!ready) console.warn(`auth: skipped, ${(pin as { missing: string }).missing} (set CONVEX_BACKEND_BIN)`);

const APP = resolve(import.meta.dir, "../auth-app");
const PASSWORD = "correct horse battery staple";
const NEW_PASSWORD = "a whole new password here";
let convex: Backend;
let bunvex: Backend;

const prepare = authAppPreparer((pin as { modules: string }).modules);

beforeAll(async () => {
  if (!ready) return;
  [convex, bunvex] = await startAll([startConvex({ app: APP, prepare }), startBunvex({ app: APP, prepare })]);
}, 600_000);
afterAll(async () => {
  await Promise.all([convex?.stop(), bunvex?.stop()]);
});

type Answer = { ok: boolean; value?: unknown; error?: string };

/** A call of the app's, as the caller holding `token` (none: anonymous). */
async function call(
  b: Backend,
  kind: "query" | "mutation",
  path: string,
  args: unknown,
  token?: string,
): Promise<Answer> {
  const r = await fetch(`${b.url}/api/${kind}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token && { authorization: `Bearer ${token}` }) },
    body: JSON.stringify({ path, args, format: "json" }),
  });
  const body = (await r.json()) as { status: string; value?: unknown; errorMessage?: string };
  return body.status === "success" ? { ok: true, value: body.value } : { ok: false, error: body.errorMessage };
}

type Bundle = { accessToken: string; refreshToken: string; refreshTokenExpiresAt: number; userId: string };
const payloadOf = (jwt: string) => JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString());
const headerOf = (jwt: string) => JSON.parse(Buffer.from(jwt.split(".")[0]!, "base64url").toString());

/** A system query as an admin (each backend's own scheme). */
async function system(b: Backend, path: string, args: unknown): Promise<unknown> {
  const r = await fetch(`${b.url}/api/query`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `${b.name === "convex" ? "Convex" : "Bunvex"} ${b.adminKey}`,
    },
    body: JSON.stringify({ path, args, format: "json" }),
  });
  const body = (await r.json()) as { status: string; value?: unknown; errorMessage?: string };
  if (body.status !== "success") throw new Error(`${b.name}: ${path} failed: ${body.errorMessage}`);
  return body.value;
}

/** A component's table, oldest first, as the dashboard reads it (`componentId`). */
async function rows(b: Backend, table: string, component: string): Promise<Record<string, unknown>[]> {
  const components = (await system(b, "_system/frontend/components:list", {})) as { id: string; path: string }[];
  const componentId = components.find((c) => c.path === component)?.id;
  if (componentId === undefined) throw new Error(`${b.name}: no component ${component}`);
  const page = (await system(b, "_system/frontend/paginatedTableDocuments", {
    table,
    componentId,
    filters: null,
    paginationOpts: { numItems: 1000, cursor: null },
  })) as { page: Record<string, unknown>[] };
  return [...page.page].sort((x, y) => (x._creationTime as number) - (y._creationTime as number));
}

/**
 * Once the scheduled erasure of every deleted session's refresh tokens has run (2.0.0, `437831bd`): no token left whose
 * session is gone.
 */
async function tokensErased(b: Backend): Promise<void> {
  for (const deadline = Date.now() + 30_000; Date.now() < deadline; await Bun.sleep(100)) {
    const sessions = new Set((await rows(b, "sessions", "auth")).map((s) => s._id));
    const tokens = await rows(b, "refreshTokens", "auth");
    if (tokens.every((t) => sessions.has(t.sessionId))) return;
  }
  throw new Error(`${b.name}: refresh tokens of deleted sessions still there after 30 s`);
}

/** The whole scenario on one backend: what each step answered, and every table at the end. */
async function scenario(b: Backend) {
  const steps: Record<string, unknown> = {};
  const step = (name: string, a: Answer) => {
    steps[name] = a;
    return a.value as never;
  };
  const m = (path: string, args: unknown, token?: string) => call(b, "mutation", path, args, token);
  const q = (path: string, args: unknown, token?: string) => call(b, "query", path, args, token);
  const up = (username: string, password: string) => m("auth:signUpWithUsernamePassword", { username, password });
  const signIn = (username: string, password: string) => m("auth:signInWithUsernamePassword", { username, password });

  const alice = step("signUp alice", await up("alice", PASSWORD)) as { tokens: Bundle };
  step("signUp: surrounding whitespace, before the short password", await up(" alice", "short"));
  step("signUp: a common password", await up("bob", "password123"));
  step("signUp: a short password, before the taken username", await up("ALICE", "short"));
  step("signUp: the username taken", await up("ALICE", PASSWORD));
  step("signIn: no such user", await signIn("nobody", PASSWORD));
  step("signIn: a wrong password", await signIn("alice", "wrong horse battery staple"));
  // 2.0.0: the password component's floor is 8 (`ea359653`); the method still asks 10 of a new password.
  step("signUp dave", await up("dave", PASSWORD));
  step("signIn: a wrong password of 9 characters", await signIn("dave", "wrongpass"));
  // 2.0.0: usernames are capped at 100 code points (`d3aa3b56`).
  step("signUp: a username of 101 characters", await up("u".repeat(101), PASSWORD));
  step("signIn: a username of 101 characters", await signIn("u".repeat(101), PASSWORD));
  const again = step("signIn alice (case-insensitive)", await signIn("Alice", PASSWORD)) as { tokens: Bundle };

  const token = alice.tokens.accessToken;
  step("me, signed in", await q("auth:me", {}, token));
  step("me, anonymous", await q("auth:me", {}));
  step("isAuthenticated, signed in", await q("auth:isAuthenticated", {}, token));
  const claims = payloadOf(token);
  const header = headerOf(token);

  // Refresh: rotation, a lost answer's retry, the successor, then the spent token presented again.
  const r1 = alice.tokens.refreshToken;
  const lost = step("refresh", await m("auth:refreshSession", { refreshToken: r1 })) as { tokens: Bundle };
  const retry = step("refresh: the same token again", await m("auth:refreshSession", { refreshToken: r1 })) as {
    tokens: Bundle;
  };
  const next = step(
    "refresh: the retry's successor",
    await m("auth:refreshSession", {
      refreshToken: retry.tokens.refreshToken,
    }),
  ) as { tokens: Bundle };
  step(
    "refresh: the lost answer's token, dropped",
    await m("auth:refreshSession", { refreshToken: lost.tokens.refreshToken }),
  );
  step("refresh: the session is gone", await m("auth:refreshSession", { refreshToken: next.tokens.refreshToken }));
  step("me, once the session is gone", await q("auth:me", {}, token));
  step("isAuthenticated, once the session is gone", await q("auth:isAuthenticated", {}, token));

  // changePassword, as the second session.
  const t2 = again.tokens.accessToken;
  const change = (args: Record<string, unknown>, as?: string) => m("auth:changePassword", args, as);
  step("changePassword: not signed in", await change({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }));
  step("changePassword: a short new password", await change({ currentPassword: PASSWORD, newPassword: "short" }, t2));
  step(
    "changePassword: a wrong current password",
    await change({ currentPassword: "short", newPassword: NEW_PASSWORD }, t2),
  );
  const third = step("signIn alice once more", await signIn("alice", PASSWORD)) as { tokens: Bundle };
  step(
    "changePassword, signing the others out",
    await change({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD, signOutOtherSessions: true }, t2),
  );
  step(
    "refresh: a session signed out by the change",
    await m("auth:refreshSession", {
      refreshToken: third.tokens.refreshToken,
    }),
  );
  step("signIn: the old password", await signIn("alice", PASSWORD));
  step("signIn: the new password", await signIn("alice", NEW_PASSWORD));

  // The rate limit: five attempts, then refused.
  step("signUp carol", await up("carol", PASSWORD));
  for (let i = 1; i <= 5; i++) step(`signIn carol, wrong, ${i}`, await signIn("carol", "wrong horse battery staple"));
  step("signIn carol: rate limited", await signIn("carol", PASSWORD));

  const anon = step("signInAnonymously", await m("auth:signInAnonymously", {})) as { tokens: Bundle };
  step("me, anonymous session", await q("auth:me", {}, anon.tokens.accessToken));
  step("signOut", await m("auth:signOut", { refreshToken: anon.tokens.refreshToken }));
  step("me, signed out", await q("auth:me", {}, anon.tokens.accessToken));

  await tokensErased(b);
  const tables = {
    createdUserIds: await rows(b, "createdUserIds", "auth"),
    sessions: await rows(b, "sessions", "auth"),
    refreshTokens: await rows(b, "refreshTokens", "auth"),
    passwords: await rows(b, "passwords", "authPassword"),
    usernames: await rows(b, "usernames", "authUsername"),
    anonymousAccounts: await rows(b, "accounts", "authAnonymous"),
    app: (await q("auth:appRows", {})).value,
  };
  return { steps, claims, header, tables, sessionOfToken: claims.sub as string };
}

/**
 * Whether `password` matches an argon2id PHC string, computed with `node:crypto`'s argon2: what bunvex's runtime
 * verifies with (`@bunvex/server/password`, AD-49).
 */
function verifyPhc(password: string, phc: string): Promise<boolean> {
  const [, algorithm, version, params, salt, hash] = phc.split("$");
  if (algorithm !== "argon2id" || version !== "v=19") throw new Error(`not v2's PHC string: ${phc}`);
  const p = Object.fromEntries(params!.split(",").map((kv) => kv.split("=").map((x, i) => (i ? Number(x) : x))));
  const tag = Buffer.from(hash!, "base64");
  return new Promise((resolve, reject) =>
    argon2(
      "argon2id",
      {
        message: password,
        nonce: Buffer.from(salt!, "base64"),
        memory: p.m,
        passes: p.t,
        parallelism: p.p,
        tagLength: tag.length,
      },
      (e, out) => (e ? reject(e) : resolve(timingSafeEqual(out, tag))),
    ),
  );
}

const HEX64 = /^[0-9a-f]{64}$/;
const PHC = /^\$argon2id\$v=19\$m=16384,t=3,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TIMES = new Set(["_creationTime", "expiresAt", "retiredAt", "refreshTokenExpiresAt", "creationTime"]);

/** Ids named by their first appearance, tokens, hashes, UUIDs and times by their form. */
function normalize(value: unknown, ids: Set<string>): unknown {
  const labels = new Map<string, string>();
  const walk = (v: unknown, key?: string): unknown => {
    if (Array.isArray(v)) return v.map((x) => walk(x));
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
    if (typeof v === "number") {
      if (key && TIMES.has(key)) return "<time>";
      if (key === "retryAfterMs") return v > 0 && v <= 60_000 ? "<ms up to a minute>" : v;
      return v;
    }
    if (typeof v !== "string") return v;
    if (key === "accessToken") return "<jwt>";
    if (key === "refreshToken") return /^[A-Za-z0-9_-]{43}$/.test(v) ? "<refresh token>" : v;
    if (HEX64.test(v)) return "<sha256>";
    if (PHC.test(v)) return "<argon2id phc>";
    if (UUID.test(v)) return "<uuid>";
    if (ids.has(v)) {
      if (!labels.has(v)) labels.set(v, `id${labels.size + 1}`);
      return labels.get(v);
    }
    return v;
  };
  return walk(value);
}

/** Every document id in a scenario's tables. */
function idsOf(tables: Record<string, unknown>): Set<string> {
  const ids = new Set<string>();
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") {
      const id = (v as { _id?: unknown })._id;
      if (typeof id === "string") ids.add(id);
      Object.values(v).forEach(walk);
    }
  };
  walk(tables);
  return ids;
}

describe.skipIf(!ready)("built-in auth, Convex Auth 2.0.0 at the pin vs @bunvex/auth", () => {
  let c: Awaited<ReturnType<typeof scenario>>;
  let x: Awaited<ReturnType<typeof scenario>>;
  beforeAll(async () => {
    c = await scenario(convex);
    x = await scenario(bunvex);
  }, 300_000);

  test("every step answers the same", () => {
    const cIds = idsOf(c.tables);
    const xIds = idsOf(x.tables);
    // `userId`s and session ids are documents of the tables: named alike by their first appearance in the same steps.
    expect(normalize({ steps: x.steps }, xIds)).toEqual(normalize({ steps: c.steps }, cIds));
  });

  test("every table holds the same rows", () => {
    expect(normalize(x.tables, idsOf(x.tables))).toEqual(normalize(c.tables, idsOf(c.tables)));
  });

  test("the access token: the same header fields and claims, bar the audience and the issuer's origin", () => {
    expect(Object.keys(x.header).sort()).toEqual(Object.keys(c.header).sort());
    expect(x.header.alg).toBe(c.header.alg);
    expect(Object.keys(x.claims).sort()).toEqual(Object.keys(c.claims).sort());
    expect(c.claims.aud).toBe("convex-auth");
    expect(x.claims.aud).toBe("bunvex-auth"); // DV-576
    for (const claims of [c.claims, x.claims]) {
      expect(claims.exp - claims.iat).toBe(60);
      expect(claims.iss).toMatch(/\/components\/auth$/);
    }
    // The subject is the session (an id of the core's `sessions`, revoked by the end: the spent token's reuse), not the
    // user: it is no user id.
    for (const side of [c, x]) {
      expect(side.sessionOfToken).toMatch(/^[a-z0-9]{32}$/);
      expect((side.tables.app as { users: { _id: string }[] }).users.map((u) => u._id)).not.toContain(
        side.sessionOfToken,
      );
    }
  });

  test("a password hash Convex's side stored verifies with bunvex's verifier (node:crypto's argon2)", async () => {
    const stored = c.tables.passwords.map((p) => p.passwordHashPHC as string);
    expect(stored.length).toBeGreaterThan(0);
    // alice's is the new password's, carol's the first's.
    expect(await verifyPhc(NEW_PASSWORD, stored[0]!)).toBe(true);
    expect(await verifyPhc(PASSWORD, stored[1]!)).toBe(true);
    expect(await verifyPhc("wrong horse battery staple", stored[1]!)).toBe(false);
  });
});
