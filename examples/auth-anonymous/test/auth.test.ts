// The anonymous example's functions: the upstream example's suite (3 tests), plus the app's own mutation as the
// signed-in user. Each test runs this app on a deployment of its own (`@bunvex/testing`).
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { resolve } from "node:path";
import { sessionIdentity } from "@bunvex/auth/test";
import { bunvexTest, type TestBunvex } from "@bunvex/testing";
import { api } from "../bunvex/_generated/api.js";

const DIR = resolve(import.meta.dir, "..");
const open: TestBunvex[] = [];
afterEach(async () => {
  for (const t of open.splice(0)) await t.close();
});
// Each test pushes a deployment of its own; under a full run a push can take past the default 5 s.
setDefaultTimeout(60_000);

function setup(): TestBunvex {
  const t = bunvexTest({ cwd: DIR });
  open.push(t);
  return t;
}

const payloadOf = (jwt: string) => JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString());

describe("anonymous sign in", () => {
  test("returns a token bundle in the shared sign-in envelope", async () => {
    const t = setup();
    const result = await t.mutation(api.auth.signInAnonymously, {});
    // Every method answers the same `{ status, tokens }`: a server-rendering host's proxy finds the refresh token there.
    expect(result.status).toBe("complete");
    const { tokens } = result;
    expect(tokens.userId).not.toBe(null);
    expect(tokens.accessToken).not.toBe(null);
    expect(tokens.refreshToken).not.toBe(null);
    expect(tokens.refreshTokenExpiresAt).toBeGreaterThan(t.now());
  });

  test("returned access token is valid JWT", async () => {
    const t = setup();
    const { tokens } = await t.mutation(api.auth.signInAnonymously, {});
    const jwt = payloadOf(tokens.accessToken);
    // The subject is the session, not the user.
    expect(jwt.sub).toEqual(expect.any(String));
    expect(jwt.sub).not.toBe(tokens.userId);
  });

  test("resolves the signed-in user through the session", async () => {
    const t = setup();
    const { tokens } = await t.mutation(api.auth.signInAnonymously, {});
    const caller = t.withIdentity(sessionIdentity(tokens));
    expect((await caller.query(api.users.me, {}))?._id).toBe(tokens.userId);
    // The access token still verifies, but its session is gone.
    await t.mutation(api.auth.signOut, { refreshToken: tokens.refreshToken });
    expect(await caller.query(api.users.me, {})).toBeNull();
  });

  test("each sign-in is a new user; only a signed-in caller counts a visit", async () => {
    const t = setup();
    const first = (await t.mutation(api.auth.signInAnonymously, {})).tokens;
    const second = (await t.mutation(api.auth.signInAnonymously, {})).tokens;
    expect(second.userId).not.toBe(first.userId);
    const visitor = t.withIdentity(sessionIdentity(first));
    expect(await visitor.mutation(api.users.visit, {})).toBe(1);
    expect(await visitor.mutation(api.users.visit, {})).toBe(2);
    await expect(t.mutation(api.users.visit, {})).rejects.toThrow("Sign in first");
  });
});
