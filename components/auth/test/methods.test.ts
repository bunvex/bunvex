// The methods' server side end to end (STUDY-201 §1.9, STUDY-208 §1.11–§1.14): an app with the core and the three method
// components mounted (fixtures/app), wired as an app wires them (`setupAuth`, `setupUsernamePassword`, `setupAnonymous`).
// Upstream checks these flows in its examples' suites, ported with the examples; these check each result arm and its
// order here, and the core mounted under another name (fixtures/misnamed-app).
// biome-ignore-all lint/suspicious/noExplicitAny: the app's api is untyped
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { anyApi, componentsGeneric } from "@bunvex/server";
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
// Each test pushes a deployment of its own; under a full `bun run check` a push can take past the default 5 s.
setDefaultTimeout(60_000);

function setup(fixture = "app"): TestBunvex {
  const t = bunvexTest({ cwd: join(import.meta.dir, "fixtures", fixture) });
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
    expect(await rows(t, "users")).toEqual([
      expect.objectContaining({ _id: tokens.userId, method: "usernamePassword" }),
    ]);
    expect(await rows(t, "signIns")).toEqual([
      expect.objectContaining({ userId: tokens.userId, method: "usernamePassword" }),
    ]);
    // Signed by the deployment, issued by the core's path, for bunvex's audience; its subject is the session.
    const { payload } = await jwtVerify(tokens.accessToken, createLocalJWKSet(await t.jwks()), {
      audience: "bunvex-auth",
    });
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

  test("a new password needs 10 characters, though the component accepts 8", async () => {
    const t = setup();
    // 9 characters: the password component accepts it, the method does not.
    expect(await signUp(t, "alice", "kY7t-vQ2m")).toEqual({
      status: "error",
      userError: { error: "PASSWORD_TOO_SHORT", minimumLength: 10 },
    });
    await signUp(t, "alice", PASSWORD);
    // At sign-in, the component's floor: under 8 is too short, 8 or 9 is checked.
    expect(await signIn(t, "alice", "short")).toEqual({
      status: "error",
      userError: { error: "PASSWORD_TOO_SHORT", minimumLength: 8 },
    });
    expect(await signIn(t, "alice", "kY7t-vQ2m")).toEqual({
      status: "error",
      userError: { error: "INVALID_CREDENTIALS" },
    });
  });

  test("a username over 100 code points is USERNAME_TOO_LONG at sign-up and USER_NOT_FOUND at sign-in", async () => {
    const t = setup();
    expect(await signUp(t, `  ${"a".repeat(101)}`, "short")).toEqual({
      status: "error",
      userError: { error: "USERNAME_TOO_LONG", maximumLength: 100 },
    });
    expect(await signIn(t, "a".repeat(101), PASSWORD)).toEqual({
      status: "error",
      userError: { error: "USER_NOT_FOUND" },
    });
    tokensOf(await signUp(t, "😀".repeat(100), PASSWORD));
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

  test("is NOT_LOGGED_IN without a live session", async () => {
    const t = setup();
    expect(await change(t, null, { currentPassword: PASSWORD, newPassword: "a whole new password" })).toEqual({
      success: false,
      userError: { error: "NOT_LOGGED_IN" },
    });
    const tokens = tokensOf(await signUp(t, "alice", PASSWORD));
    await t.mutation(api.auth.signOut, { refreshToken: tokens.refreshToken });
    expect(await change(t, tokens, { currentPassword: PASSWORD, newPassword: "a whole new password" })).toEqual({
      success: false,
      userError: { error: "NOT_LOGGED_IN" },
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

describe("bindMethod", () => {
  test("a method name bound twice to one core throws", async () => {
    const { setupAuth } = await import("../src/server/setup.ts");
    const core = setupAuth({ component: {} as never });
    const createUser = {} as never;
    core.bindMethod({ name: "usernamePassword", createUser });
    expect(() => core.bindMethod({ name: "usernamePassword", createUser })).toThrow(
      'A sign-in method named "usernamePassword" is already bound to this auth core. The app\'s callbacks get the ' +
        "name of the sign-in method as `method.name`, so each sign-in method must have a unique name.",
    );
  });
});

describe("the core's mount", () => {
  test("a core mounted under another name than `auth` fails the first sign-in, and keeps nothing", async () => {
    const t = setup("misnamed-app");
    await expect(signUp(t, "alice", PASSWORD)).rejects.toThrow(
      'The auth component is mounted at "myAuth", but it must be mounted at "auth". Use `app.use(auth)` in ' +
        "bunvex.config.ts, without a `name` option.",
    );
    // The whole mutation rolled back: the app's user, the username, the session.
    expect(await rows(t, "users")).toEqual([]);
    expect(
      await t.query((componentsGeneric() as any).authUsername.public.getUserIdByUsername, { username: "alice" }),
    ).toBeNull();
  });
});
