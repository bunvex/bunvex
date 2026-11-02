// `setupAuth`'s method helpers and `isAuthenticated` (STUDY-201 §3.4), upstream's `server/setup.test.ts` ported: an app
// with the core mounted (fixtures/setup-app), where the real `setupAuth` binds a test method whose mutations expose each
// helper on `ctx.bunvexAuth`. Vitest's fake timers are the deployment's virtual clock.
// biome-ignore-all lint/suspicious/noExplicitAny: the app's api is untyped
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { anyApi } from "@bunvex/server";
import { bunvexTest, type TestBunvex } from "@bunvex/testing";
import type { TokenBundle } from "../src/lib/types.ts";
import { sessionIdentity } from "../src/test.ts";

const api = (anyApi as any).testApp;
const open: TestBunvex[] = [];
afterEach(async () => {
  for (const t of open.splice(0)) await t.close();
});
// Each test pushes a deployment of its own; under a full `bun run check` a push can take past the default 5 s.
setDefaultTimeout(60_000);

function setup(): TestBunvex {
  const t = bunvexTest({ cwd: join(import.meta.dir, "fixtures", "setup-app") });
  open.push(t);
  return t;
}

const signUp = (t: TestBunvex, accountId: string): Promise<TokenBundle> => t.mutation(api.signUp, { accountId });
const signIn = (t: TestBunvex, accountId: string): Promise<TokenBundle> => t.mutation(api.signIn, { accountId });
/** The ids of the user's sessions, as the core lists them. */
const sessionIdsOf = (t: TestBunvex, userId: string): Promise<string[]> => t.mutation(api.sessionIds, { userId });
const DAYS_31 = 31 * 24 * 60 * 60 * 1000;

describe("ctx.bunvexAuth.revokeOtherSessions", () => {
  test("revokes every session of the user but the caller's", async () => {
    const t = setup();
    const bundle = await signUp(t, "alice");
    await signIn(t, "alice");
    await signIn(t, "alice");
    expect(await t.withIdentity(sessionIdentity(bundle)).mutation(api.revokeOtherSessions, {})).toBe(2);
  });

  test("leaves the sessions of other users alone", async () => {
    const t = setup();
    const bundle = await signUp(t, "alice");
    await signIn(t, "alice");
    const bobBundle = await signUp(t, "bob");
    await signIn(t, "bob");

    expect(await t.withIdentity(sessionIdentity(bundle)).mutation(api.revokeOtherSessions, {})).toBe(1);
    // Bob's other session survived, so Bob still has one to revoke.
    expect(await t.withIdentity(sessionIdentity(bobBundle)).mutation(api.revokeOtherSessions, {})).toBe(1);
  });

  test("deletes expired sessions without counting them", async () => {
    const t = setup();
    await signUp(t, "alice");
    // Past the default 30-day refresh-token lifetime.
    await t.advanceTime(DAYS_31);
    await signIn(t, "alice");
    const bundle = await signIn(t, "alice");

    expect(await t.withIdentity(sessionIdentity(bundle)).mutation(api.revokeOtherSessions, {})).toBe(1);
    // The expired session was deleted too, so nothing is left to revoke.
    expect(await sessionIdsOf(t, bundle.userId)).toEqual([sessionIdentity(bundle).subject]);
  });

  test("returns 0 when the caller is not signed in", async () => {
    const t = setup();
    await signUp(t, "alice");
    await signIn(t, "alice");
    expect(await t.mutation(api.revokeOtherSessions, {})).toBe(0);
  });

  test("returns 0 for a subject that is no session", async () => {
    const t = setup();
    const bundle = await signUp(t, "alice");
    await signIn(t, "alice");
    expect(await t.withIdentity({ subject: bundle.userId }).mutation(api.revokeOtherSessions, {})).toBe(0);
  });
});

describe("ctx.bunvexAuth.revokeAllSessions", () => {
  test("revokes every session of the user, the caller's included", async () => {
    const t = setup();
    const bundle = await signUp(t, "alice");
    await signIn(t, "alice");
    expect(
      await t.withIdentity(sessionIdentity(bundle)).mutation(api.revokeAllSessions, { userId: bundle.userId }),
    ).toBe(2);
    expect(await sessionIdsOf(t, bundle.userId)).toEqual([]);
  });

  test("needs no signed-in caller", async () => {
    const t = setup();
    const bundle = await signUp(t, "alice");
    expect(await t.mutation(api.revokeAllSessions, { userId: bundle.userId })).toBe(1);
    expect(await sessionIdsOf(t, bundle.userId)).toEqual([]);
  });

  test("leaves the sessions of other users alone", async () => {
    const t = setup();
    const alice = await signUp(t, "alice");
    const bob = await signUp(t, "bob");
    expect(await t.mutation(api.revokeAllSessions, { userId: alice.userId })).toBe(1);
    expect(await sessionIdsOf(t, bob.userId)).toEqual([sessionIdentity(bob).subject]);
  });

  test("deletes expired sessions without counting them", async () => {
    const t = setup();
    const bundle = await signUp(t, "alice");
    // Past the default 30-day refresh-token lifetime.
    await t.advanceTime(DAYS_31);
    await signIn(t, "alice");
    expect(await t.mutation(api.revokeAllSessions, { userId: bundle.userId })).toBe(1);
    expect(await sessionIdsOf(t, bundle.userId)).toEqual([]);
  });

  test("returns 0 for a user with no sessions", async () => {
    const t = setup();
    expect(await t.mutation(api.revokeAllSessions, { userId: "nobody" })).toBe(0);
  });
});

describe("isAuthenticated", () => {
  test("is false for a caller with no identity", async () => {
    const t = setup();
    expect(await t.query(api.isAuthenticated, {})).toBe(false);
  });

  test("is false for a subject that is no session", async () => {
    const t = setup();
    expect(await t.withIdentity({ subject: "not-a-session-id" }).query(api.isAuthenticated, {})).toBe(false);
  });

  test("is true while the session is live, and false once it is revoked", async () => {
    const t = setup();
    const bundle = await signUp(t, "alice");
    const caller = t.withIdentity(sessionIdentity(bundle));
    expect(await caller.query(api.isAuthenticated, {})).toBe(true);

    await t.mutation(api.signOut, { refreshToken: bundle.refreshToken });
    // The token is untouched and still verifies; the session is what died.
    expect(await caller.query(api.isAuthenticated, {})).toBe(false);
  });
});

describe("bindProvider", () => {
  test("resolveUserId finds the user of one of the method's account ids, and null for another", async () => {
    const t = setup();
    const bundle = await signUp(t, "alice");
    expect(await t.mutation(api.resolveUserId, { accountId: "alice" })).toBe(bundle.userId);
    expect(await t.mutation(api.resolveUserId, { accountId: "bob" })).toBe(null);
  });

  test("refreshSession rotates through the app's export", async () => {
    const t = setup();
    const bundle = await signUp(t, "alice");
    const result = await t.mutation(api.refreshSession, { refreshToken: bundle.refreshToken });
    expect(result.kind).toBe("rotated");
    expect(result.tokens.userId).toBe(bundle.userId);
  });
});
