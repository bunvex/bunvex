// The methods' server side end to end (STUDY-201 §1.9): an app with the core and the three method components mounted
// (fixtures/app), wired as an app wires them (`setupAuth`, `setupUsernamePassword`, `setupAnonymous`). Upstream checks
// these flows in its examples' suites, ported with the examples; these check each result arm and its order here.
// biome-ignore-all lint/suspicious/noExplicitAny: the app's api is untyped
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { anyApi } from "@bunvex/server";
import { bunvexTest, type TestBunvex } from "@bunvex/testing";
import { createLocalJWKSet, jwtVerify } from "jose";
import type { TokenBundle } from "../src/lib/types.ts";
import { sessionIdentity } from "../src/test.ts";

const api = anyApi as any;
const PASSWORD = "correct horse battery staple";
const open: TestBunvex[] = [];
afterEach(async () => {
  for (const t of open.splice(0)) await t.close();
});

function setup(): TestBunvex {
  const t = bunvexTest({ cwd: join(import.meta.dir, "fixtures", "app") });
  open.push(t);
  return t;
}

const signUp = (t: TestBunvex, username: string, password: string) =>
  t.mutation(api.auth.signUpWithUsernamePassword, { username, password });
const signIn = (t: TestBunvex, username: string, password: string) =>
  t.mutation(api.auth.signInWithUsernamePassword, { username, password });
const tokensOf = (result: { status: string; tokens?: TokenBundle }): TokenBundle => {
  expect(result.status).toBe("complete");
  return result.tokens!;
};
const rows = (t: TestBunvex, table: string) => t.run(async (ctx: any) => await ctx.db.query(table).collect());

describe("setupUsernamePassword", () => {
  test("sign-up makes the user, runs onSignIn and returns a session the deployment signed for the core", async () => {
    const t = setup();
    const tokens = tokensOf(await signUp(t, "alice", PASSWORD));
    expect(await rows(t, "users")).toEqual([expect.objectContaining({ _id: tokens.userId, method: "password" })]);
    expect(await rows(t, "signIns")).toEqual([expect.objectContaining({ userId: tokens.userId, method: "password" })]);
    // Signed by the deployment, issued by the core's path, for bunvex's audience; its subject is the session.
    const { payload } = await jwtVerify(tokens.accessToken, createLocalJWKSet(await t.jwks()), { audience: "bunvex" });
    expect(payload.iss).toMatch(/\/components\/auth$/);
    expect(await t.withIdentity(sessionIdentity(tokens)).query(api.auth.me, {})).toBe(tokens.userId);
  });

  test("sign-in with the right password resolves the same user and runs onSignIn again", async () => {
    const t = setup();
    const up = tokensOf(await signUp(t, "alice", PASSWORD));
    const back = tokensOf(await signIn(t, "Alice", PASSWORD));
    expect(back.userId).toBe(up.userId);
    expect(back.refreshToken).not.toBe(up.refreshToken);
    expect(await rows(t, "signIns")).toHaveLength(2);
    expect(await rows(t, "users")).toHaveLength(1);
  });

  test("an unknown username is USER_NOT_FOUND, a wrong password INVALID_CREDENTIALS", async () => {
    const t = setup();
    await signUp(t, "alice", PASSWORD);
    expect(await signIn(t, "bob", PASSWORD)).toEqual({ status: "error", userError: { error: "USER_NOT_FOUND" } });
    expect(await signIn(t, "alice", "wrong horse battery staple")).toEqual({
      status: "error",
      userError: { error: "INVALID_CREDENTIALS" },
    });
  });

  test("sign-up checks the username, then the password, then whether the username is taken", async () => {
    const t = setup();
    expect(await signUp(t, " alice", "short")).toEqual({
      status: "error",
      userError: { error: "USERNAME_HAS_SURROUNDING_WHITESPACE" },
    });
    expect(await signUp(t, "alice", "password123")).toEqual({
      status: "error",
      userError: { error: "PASSWORD_TOO_COMMON" },
    });
    await signUp(t, "alice", PASSWORD);
    expect(await signUp(t, "ALICE", "short")).toEqual({
      status: "error",
      userError: { error: "PASSWORD_TOO_SHORT", minimumLength: 10 },
    });
    expect(await signUp(t, "ALICE", PASSWORD)).toEqual({ status: "error", userError: { error: "USERNAME_TAKEN" } });
    // Nothing was created for the refused attempts.
    expect(await rows(t, "users")).toHaveLength(1);
  });

  test("sign-in's rate limit is per user: the sixth attempt in a minute is RATE_LIMITED", async () => {
    const t = setup();
    await signUp(t, "alice", PASSWORD);
    for (let i = 0; i < 5; i++) await signIn(t, "alice", "wrong horse battery staple");
    const limited = await signIn(t, "alice", PASSWORD);
    expect(limited.status).toBe("error");
    expect(limited.userError.error).toBe("RATE_LIMITED");
  });
});

describe("changePassword", () => {
  const change = (t: TestBunvex, tokens: TokenBundle | null, args: Record<string, unknown>) =>
    (tokens === null ? t : t.withIdentity(sessionIdentity(tokens))).mutation(api.auth.changePassword, args);

  test("is NOT_SIGNED_IN without a live session", async () => {
    const t = setup();
    expect(await change(t, null, { currentPassword: PASSWORD, newPassword: "a whole new password" })).toEqual({
      success: false,
      userError: { error: "NOT_SIGNED_IN" },
    });
    const tokens = tokensOf(await signUp(t, "alice", PASSWORD));
    await t.mutation(api.auth.signOut, { refreshToken: tokens.refreshToken });
    expect(await change(t, tokens, { currentPassword: PASSWORD, newPassword: "a whole new password" })).toEqual({
      success: false,
      userError: { error: "NOT_SIGNED_IN" },
    });
  });

  test("changes the password: the new one signs in, the old one no longer", async () => {
    const t = setup();
    const tokens = tokensOf(await signUp(t, "alice", PASSWORD));
    expect(await change(t, tokens, { currentPassword: PASSWORD, newPassword: "a whole new password" })).toEqual({
      success: true,
    });
    tokensOf(await signIn(t, "alice", "a whole new password"));
    expect((await signIn(t, "alice", PASSWORD)).userError).toEqual({ error: "INVALID_CREDENTIALS" });
  });

  test("a refused new password costs no attempt; the current password's errors are all INVALID_CREDENTIALS", async () => {
    const t = setup();
    const tokens = tokensOf(await signUp(t, "alice", PASSWORD));
    for (let i = 0; i < 6; i++)
      expect(await change(t, tokens, { currentPassword: PASSWORD, newPassword: "short" })).toEqual({
        success: false,
        userError: { error: "PASSWORD_TOO_SHORT", minimumLength: 10 },
      });
    expect(await change(t, tokens, { currentPassword: "short", newPassword: "a whole new password" })).toEqual({
      success: false,
      userError: { error: "INVALID_CREDENTIALS" },
    });
    expect(
      await change(t, tokens, { currentPassword: "wrong horse battery staple", newPassword: "a whole new password" }),
    ).toEqual({ success: false, userError: { error: "INVALID_CREDENTIALS" } });
    // Two attempts used of five: the right one still goes through.
    expect(await change(t, tokens, { currentPassword: PASSWORD, newPassword: "a whole new password" })).toEqual({
      success: true,
    });
  });

  test("signOutOtherSessions signs the user's other sessions out, not this one", async () => {
    const t = setup();
    const tokens = tokensOf(await signUp(t, "alice", PASSWORD));
    const other = tokensOf(await signIn(t, "alice", PASSWORD));
    expect(
      await change(t, tokens, {
        currentPassword: PASSWORD,
        newPassword: "a whole new password",
        signOutOtherSessions: true,
      }),
    ).toEqual({ success: true });
    expect((await t.mutation(api.auth.refreshSession, { refreshToken: other.refreshToken })).kind).toBe("noSession");
    expect((await t.mutation(api.auth.refreshSession, { refreshToken: tokens.refreshToken })).kind).toBe("rotated");
  });
});

describe("setupAnonymous", () => {
  test("every sign-in is a new account and user, with a session", async () => {
    const t = setup();
    const first = (await t.mutation(api.auth.signInAnonymously, {})) as { status: string; tokens: TokenBundle };
    const second = (await t.mutation(api.auth.signInAnonymously, {})) as { status: string; tokens: TokenBundle };
    expect(first.status).toBe("complete");
    expect(second.tokens.userId).not.toBe(first.tokens.userId);
    expect((await rows(t, "users")).map((u: { method: string }) => u.method)).toEqual(["anonymous", "anonymous"]);
    // No onSignIn was attached for this method.
    expect(await rows(t, "signIns")).toEqual([]);
    expect(await t.withIdentity(sessionIdentity(first.tokens)).query(api.auth.isAuthenticated, {})).toBe(true);
  });
});

describe("bindProvider", () => {
  test("a method name bound twice to one core throws", async () => {
    const { setupAuth } = await import("../src/server/setup.ts");
    const core = setupAuth({ component: {} as never });
    const createUser = {} as never;
    core.bindProvider({ name: "password", createUser });
    expect(() => core.bindProvider({ name: "password", createUser })).toThrow(
      'A sign-in method named "password" is already bound to this auth core. Method names key the accounts table, so ' +
        "each method must have a unique name.",
    );
  });
});
