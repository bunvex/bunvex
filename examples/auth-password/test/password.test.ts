// The username + password example's functions: the upstream example's suite (20 tests) and two more. Each test runs
// this app on a deployment of its own, in the test's process (`@bunvex/testing`), a user calling as their session
// (`sessionIdentity`).
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { resolve } from "node:path";
import { sessionIdentity } from "@bunvex/auth/test";
import { bunvexTest, type TestBunvex } from "@bunvex/testing";
import { api, components } from "../bunvex/_generated/api.js";

const DIR = resolve(import.meta.dir, "..");
const PASSWORD = "correct horse battery staple";
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

type Tokens = { accessToken: string; refreshToken: string; refreshTokenExpiresAt: number; userId: string };
type Complete = { status: "complete"; tokens: Tokens };
const signUp = (t: TestBunvex, username: string, password: string) =>
  t.mutation(api.auth.signUpWithUsernamePassword, { username, password });
const signIn = (t: TestBunvex, username: string, password: string) =>
  t.mutation(api.auth.signInWithUsernamePassword, { username, password });
const asUser = (t: TestBunvex, tokens: { accessToken: string }) => t.withIdentity(sessionIdentity(tokens));
const aSession = {
  status: "complete",
  tokens: {
    accessToken: expect.any(String),
    refreshToken: expect.any(String),
    refreshTokenExpiresAt: expect.any(Number),
    userId: expect.any(String),
  },
};

describe("setupUsernamePassword", () => {
  test("signs up a new user and returns a session", async () => {
    const t = setup();
    expect(await signUp(t, "alice", PASSWORD)).toEqual(aSession);
  });

  test("signs in with the correct password", async () => {
    const t = setup();
    const up = await signUp(t, "alice", PASSWORD);
    const back = await signIn(t, "alice", PASSWORD);
    expect(up).toEqual(aSession);
    expect(back).toEqual(aSession);
    // The same identity, the same app user.
    expect((back as Complete).tokens.userId).toBe((up as Complete).tokens.userId);
  });

  test("two users get distinct accounts and sessions", async () => {
    const t = setup();
    const alice = (await signUp(t, "alice", PASSWORD)) as Complete;
    const bob = (await signUp(t, "bob", "different horse battery staple")) as Complete;
    expect(alice.status).toBe("complete");
    expect(bob.status).toBe("complete");
    expect(bob.tokens.userId).not.toBe(alice.tokens.userId);
    // Each signs in as themselves, not as the first user.
    expect(((await signIn(t, "alice", PASSWORD)) as Complete).tokens.userId).toBe(alice.tokens.userId);
    expect(((await signIn(t, "bob", "different horse battery staple")) as Complete).tokens.userId).toBe(
      bob.tokens.userId,
    );
  });

  test("rejects a wrong password with INVALID_CREDENTIALS", async () => {
    const t = setup();
    await signUp(t, "alice", PASSWORD);
    expect(await signIn(t, "alice", "wrong horse battery staple")).toEqual({
      status: "error",
      userError: { error: "INVALID_CREDENTIALS" },
    });
  });

  test("rejects an unknown username with USER_NOT_FOUND", async () => {
    const t = setup();
    expect(await signIn(t, "nobody", PASSWORD)).toEqual({ status: "error", userError: { error: "USER_NOT_FOUND" } });
  });

  test("rejects signing up a taken username", async () => {
    const t = setup();
    await signUp(t, "alice", PASSWORD);
    expect(await signUp(t, "alice", PASSWORD)).toEqual({ status: "error", userError: { error: "USERNAME_TAKEN" } });
  });

  test("usernames are case-insensitive", async () => {
    const t = setup();
    const up = await signUp(t, "Alice", PASSWORD);
    expect(up).toEqual(aSession);
    // Another casing is the same account, for signing in…
    const back = await signIn(t, "ALICE", PASSWORD);
    expect(back).toEqual(aSession);
    expect((back as Complete).tokens.userId).toBe((up as Complete).tokens.userId);
    // …and for the taken-username check.
    expect(await signUp(t, "alice", PASSWORD)).toEqual({ status: "error", userError: { error: "USERNAME_TAKEN" } });
  });

  test("rejects an empty username at sign-up", async () => {
    const t = setup();
    expect(await signUp(t, "", PASSWORD)).toEqual({
      status: "error",
      userError: { error: "USERNAME_TOO_SHORT", minimumLength: 1 },
    });
  });

  test("rejects a username of more than 100 characters at sign-up, and finds no user at sign-in", async () => {
    const t = setup();
    expect(await signUp(t, "a".repeat(101), PASSWORD)).toEqual({
      status: "error",
      userError: { error: "USERNAME_TOO_LONG", maximumLength: 100 },
    });
    expect(await signIn(t, "a".repeat(101), PASSWORD)).toEqual({
      status: "error",
      userError: { error: "USER_NOT_FOUND" },
    });
  });

  test("stores the username in the username component", async () => {
    const t = setup();
    const up = (await signUp(t, "Alice", PASSWORD)) as Complete;
    expect(await t.query(components.authUsername.public.getUsername, { userId: up.tokens.userId })).toBe("Alice");
  });

  test("rejects a too-short password at sign-up without creating an account", async () => {
    const t = setup();
    // 9 characters: the password component accepts it, the method does not.
    expect(await signUp(t, "alice", "kY7t-vQ2m")).toEqual({
      status: "error",
      userError: { error: "PASSWORD_TOO_SHORT", minimumLength: 10 },
    });
    // No account was made, so signing up with a valid password works.
    expect(await signUp(t, "alice", PASSWORD)).toEqual(aSession);
  });
});

describe("changePassword", () => {
  const NEW_PASSWORD = "new horse battery staple";

  async function signedUpUser() {
    const t = setup();
    const { tokens } = (await signUp(t, "alice", PASSWORD)) as Complete;
    return { t, userId: tokens.userId, alice: asUser(t, tokens) };
  }

  test("replaces the password when the current one is correct", async () => {
    const { t, alice } = await signedUpUser();
    expect(
      await alice.mutation(api.auth.changePassword, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }),
    ).toEqual({ success: true });
    expect(await signIn(t, "alice", PASSWORD)).toEqual({
      status: "error",
      userError: { error: "INVALID_CREDENTIALS" },
    });
    expect(await signIn(t, "alice", NEW_PASSWORD)).toMatchObject({ status: "complete" });
  });

  test("signs out the user's other sessions when requested", async () => {
    const t = setup();
    const current = (await signUp(t, "alice", PASSWORD)) as Complete;
    const other = (await signIn(t, "alice", PASSWORD)) as Complete;
    expect(
      await asUser(t, current.tokens).mutation(api.auth.changePassword, {
        currentPassword: PASSWORD,
        newPassword: NEW_PASSWORD,
        signOutOtherSessions: true,
      }),
    ).toEqual({ success: true });
    // The other session can no longer refresh; the current one can.
    expect(await t.mutation(api.auth.refreshSession, { refreshToken: other.tokens.refreshToken })).toMatchObject({
      kind: "noSession",
    });
    expect(await t.mutation(api.auth.refreshSession, { refreshToken: current.tokens.refreshToken })).toMatchObject({
      kind: "rotated",
    });
  });

  test("keeps the user's other sessions by default", async () => {
    const t = setup();
    const current = (await signUp(t, "alice", PASSWORD)) as Complete;
    const other = (await signIn(t, "alice", PASSWORD)) as Complete;
    expect(
      await asUser(t, current.tokens).mutation(api.auth.changePassword, {
        currentPassword: PASSWORD,
        newPassword: NEW_PASSWORD,
      }),
    ).toEqual({ success: true });
    expect(await t.mutation(api.auth.refreshSession, { refreshToken: other.tokens.refreshToken })).toMatchObject({
      kind: "rotated",
    });
  });

  test("refuses a signed-out caller", async () => {
    const { t } = await signedUpUser();
    expect(await t.mutation(api.auth.changePassword, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD })).toEqual(
      { success: false, userError: { error: "NOT_LOGGED_IN" } },
    );
  });

  test("rejects a wrong current password and keeps the old one", async () => {
    const { t, alice } = await signedUpUser();
    expect(
      await alice.mutation(api.auth.changePassword, {
        currentPassword: "wrong horse battery staple",
        newPassword: NEW_PASSWORD,
      }),
    ).toEqual({ success: false, userError: { error: "INVALID_CREDENTIALS" } });
    expect(await signIn(t, "alice", PASSWORD)).toMatchObject({ status: "complete" });
  });

  test("reports a malformed current password as INVALID_CREDENTIALS", async () => {
    const { alice } = await signedUpUser();
    expect(
      await alice.mutation(api.auth.changePassword, { currentPassword: "short", newPassword: NEW_PASSWORD }),
    ).toEqual({ success: false, userError: { error: "INVALID_CREDENTIALS" } });
  });

  test("rejects a new password that is too common", async () => {
    const { t, alice } = await signedUpUser();
    expect(
      await alice.mutation(api.auth.changePassword, { currentPassword: PASSWORD, newPassword: "0000000000" }),
    ).toEqual({ success: false, userError: { error: "PASSWORD_TOO_COMMON" } });
    expect(await signIn(t, "alice", PASSWORD)).toMatchObject({ status: "complete" });
  });

  test("rejects a new password that is too short", async () => {
    const { alice } = await signedUpUser();
    expect(await alice.mutation(api.auth.changePassword, { currentPassword: PASSWORD, newPassword: "short" })).toEqual({
      success: false,
      userError: { error: "PASSWORD_TOO_SHORT", minimumLength: 10 },
    });
  });

  test("accepts a new password equal to the current one", async () => {
    const { t, alice } = await signedUpUser();
    expect(await alice.mutation(api.auth.changePassword, { currentPassword: PASSWORD, newPassword: PASSWORD })).toEqual(
      { success: true },
    );
    expect(await signIn(t, "alice", PASSWORD)).toMatchObject({ status: "complete" });
  });

  test("rate limits the current-password checks per user", async () => {
    const { alice } = await signedUpUser();
    for (let i = 0; i < 5; i++)
      await alice.mutation(api.auth.changePassword, {
        currentPassword: "wrong horse battery staple",
        newPassword: NEW_PASSWORD,
      });
    expect(
      await alice.mutation(api.auth.changePassword, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }),
    ).toEqual({ success: false, userError: { error: "RATE_LIMITED", retryAfterMs: expect.any(Number) } });
  });
});

describe("loggedInUser", () => {
  test("the user and their username while signed in; null once the session is gone", async () => {
    const t = setup();
    const { tokens } = (await signUp(t, "Alice", PASSWORD)) as Complete;
    const alice = asUser(t, tokens);
    expect(await alice.query(api.currentUser.loggedInUser, {})).toMatchObject({ id: tokens.userId, username: "Alice" });
    await t.mutation(api.auth.signOut, { refreshToken: tokens.refreshToken });
    expect(await alice.query(api.currentUser.loggedInUser, {})).toBeNull();
    expect(await t.query(api.currentUser.loggedInUser, {})).toBeNull();
  });
});
