// The core component's suite (STUDY-201 §3.4), upstream's `component/core.test.ts` at the pin, ported to
// `@bunvex/testing`: the component's functions pushed as an app's (fixtures/standalone), as upstream runs them, so
// `t.run` reads its tables. Vitest's fake timers are the deployment's virtual clock (`t.advanceTime`); the app
// callbacks' spies are a table the fixture writes (they run in the deployment, not in the test's process); tokens are
// verified with `jose` against `t.jwks()`, the issuer being the deployment's origin.
// biome-ignore-all lint/suspicious/noExplicitAny: the app's api and the inline functions' ctx are untyped
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { anyApi } from "@bunvex/server";
import { bunvexTest, type TestBunvex } from "@bunvex/testing";
import { createLocalJWKSet, decodeJwt, jwtVerify } from "jose";
import type { Doc, Id } from "../src/component/_generated/dataModel.ts";
import {
  REFRESH_GRACE_MS,
  SPENT_TOKEN_HORIZON_MS,
  STANDARD_ISSUED_REFRESH_TOKEN_LIMIT,
} from "../src/component/public.ts";
import { sha256Hex } from "../src/lib/crypto.ts";
import { type AuthClaims, type RefreshResult, type TokenBundle, USE_USER_ID_AS_ACCOUNT_ID } from "../src/lib/types.ts";

const api = anyApi as any;
const STANDALONE = join(import.meta.dir, "fixtures", "standalone");
const AUDIENCE = "bunvex";
const CREATE_USER_HANDLE = "testApp:createUser";
const ON_SIGN_IN_HANDLE = "testApp:onSignIn";
const THROWING_ON_SIGN_IN_HANDLE = "testApp:onSignInThatThrows";

const open: TestBunvex[] = [];
afterEach(async () => {
  for (const t of open.splice(0)) await t.close();
});

function setup(): TestBunvex {
  const t = bunvexTest({ cwd: STANDALONE });
  open.push(t);
  return t;
}

/** Verify an access token against the test deployment's JWKS, its issuer the deployment's origin. */
async function verifyAccessToken(t: TestBunvex, token: string) {
  const issuer = (await t.query(api.testApp.cloudUrl, {})) as string;
  return await jwtVerify(token, createLocalJWKSet(await t.jwks()), { issuer, audience: AUDIENCE });
}

function claims(overrides: Partial<AuthClaims> = {}): AuthClaims {
  return { providerName: "password", providerAccountId: "alice", profile: { name: "Alice" }, ...overrides };
}

const createUserCalls = (t: TestBunvex) => t.query(api.testApp.calls, { kind: "createUser" }) as Promise<unknown[]>;
const onSignInCalls = (t: TestBunvex) => t.query(api.testApp.calls, { kind: "onSignIn" }) as Promise<unknown[]>;

/** Establish a brand new identity: the account, its app user, and a session. */
async function signUp(t: TestBunvex, c: AuthClaims): Promise<TokenBundle> {
  return await t.mutation(api.public.signUp, {
    claims: c,
    createUserHandle: CREATE_USER_HANDLE,
    onSignInHandle: ON_SIGN_IN_HANDLE,
  });
}

/** Sign a known identity back in, as an app that attached an `onSignIn` does. */
async function signIn(t: TestBunvex, c: AuthClaims): Promise<TokenBundle> {
  return await t.mutation(api.public.signIn, { claims: c, onSignInHandle: ON_SIGN_IN_HANDLE });
}

/** Assert a refresh rotated the token, and narrow to the new bundle. */
function expectRotated(result: RefreshResult): TokenBundle {
  expect(result.kind).toBe("rotated");
  return (result as Extract<RefreshResult, { kind: "rotated" }>).tokens;
}

/** Exchange a refresh token, as a client rotating its session does. */
async function refresh(t: TestBunvex, refreshToken: string): Promise<RefreshResult> {
  return await t.mutation(api.public.refresh, { refreshToken });
}

/** How many sessions currently exist. */
async function sessionCount(t: TestBunvex): Promise<number> {
  return await t.run(async (ctx: any) => (await ctx.db.query("sessions").collect()).length);
}

/** The refresh tokens in the given states, oldest first. */
async function tokensInState(
  t: TestBunvex,
  ...states: Doc<"refreshTokens">["state"][]
): Promise<Doc<"refreshTokens">[]> {
  return await t.run(async (ctx: any) =>
    (await ctx.db.query("refreshTokens").collect()).filter((r: Doc<"refreshTokens">) => states.includes(r.state)),
  );
}

/** The hashes of the spent and dropped tokens, oldest first. */
async function retiredHashes(t: TestBunvex) {
  return (await tokensInState(t, "spent", "dropped")).map((r) => r.hash);
}

/** The spent and dropped tokens with how each was retired, oldest first. */
async function retiredTokens(t: TestBunvex) {
  return (await tokensInState(t, "spent", "dropped")).map((r) => ({ hash: r.hash, state: r.state }));
}

/** The hashes of the tokens no one has presented yet, oldest first. */
async function issuedHashes(t: TestBunvex) {
  return (await tokensInState(t, "issued")).map((r) => r.hash);
}

/** The hash of the session's redeemed token, if it has one. */
async function redeemedHash(t: TestBunvex) {
  const redeemed = await tokensInState(t, "redeemed");
  expect(redeemed.length).toBeLessThanOrEqual(1);
  return redeemed[0]?.hash;
}

/** The session id carried in the bundle's access token (`sub` claim). */
function sessionIdOf(bundle: TokenBundle): string {
  return decodeJwt(bundle.accessToken).sub!;
}

/** The `console.warn` lines the deployment printed while `fn` ran. */
async function warningsOf<T>(fn: () => Promise<T>): Promise<{ result: T; warnings: string[] }> {
  const warnings: string[] = [];
  const saved = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    return { result: await fn(), warnings };
  } finally {
    console.warn = saved;
  }
}

describe("signUp", () => {
  test("creates an account + session and mints a verifiable JWT", async () => {
    const t = setup();
    const bundle = await signUp(t, claims());

    expect(bundle.userId).toBeTruthy();
    expect(bundle.refreshToken).toBeTruthy();

    const sessionId = await t.run(async (ctx: any) => (await ctx.db.query("sessions").unique())?._id);
    expect(sessionId).not.toBeUndefined();

    // The access token verifies against the deployment's JWKS with the right claims. The subject is the session, not
    // the user: the app resolves the user through the session.
    const { payload } = await verifyAccessToken(t, bundle.accessToken);
    expect(payload.sub).toBe(sessionId);
    expect(payload.exp! * 1000).toBeGreaterThan(t.now());
    expect(bundle.refreshTokenExpiresAt).toBeGreaterThan(payload.exp! * 1000);

    const counts = await t.run(async (ctx: any) => ({ accounts: (await ctx.db.query("accounts").collect()).length }));
    expect(counts).toEqual({ accounts: 1 });
  });

  test("invokes the app's createUser with the claims, then onSignIn", async () => {
    const t = setup();
    const bundle = await signUp(t, claims({ profile: { name: "Alice" } }));

    expect(await createUserCalls(t)).toEqual([
      { provider: { name: "password", accountId: "alice", profile: { name: "Alice" } } },
    ]);
    // A first sign-in is still a sign-in, so onSignIn runs too, with the id createUser just returned.
    expect(await onSignInCalls(t)).toEqual([
      { provider: { name: "password", accountId: "alice", profile: { name: "Alice" } }, userId: bundle.userId },
    ]);
  });

  test("creates the user without an onSignIn attached", async () => {
    const t = setup();
    const bundle: TokenBundle = await t.mutation(api.public.signUp, {
      claims: claims(),
      createUserHandle: CREATE_USER_HANDLE,
    });

    // The account is keyed to the id the app's createUser returned.
    const account = await t.run((ctx: any) => ctx.db.query("accounts").unique());
    expect(account?.userId).toBe(bundle.userId);
    expect(await createUserCalls(t)).toHaveLength(1);
    expect(await onSignInCalls(t)).toHaveLength(0);
  });

  test("an onSignIn that throws rolls back the user it just created", async () => {
    const t = setup();
    await expect(
      t.mutation(api.public.signUp, {
        claims: claims(),
        createUserHandle: CREATE_USER_HANDLE,
        onSignInHandle: THROWING_ON_SIGN_IN_HANDLE,
      }),
    ).rejects.toThrow(/no sign-ins for you/);

    // The account insert is a write of the same mutation, so it rolls back with it, and the app's own rows the same
    // way. The session was never reached, since onSignIn runs before it is minted.
    const counts = await t.run(async (ctx: any) => ({
      accounts: (await ctx.db.query("accounts").collect()).length,
      sessions: (await ctx.db.query("sessions").collect()).length,
    }));
    expect(counts).toEqual({ accounts: 0, sessions: 0 });
    expect(await createUserCalls(t)).toHaveLength(0);
  });

  test("refuses to sign up an identity that already has an account", async () => {
    const t = setup();
    await signUp(t, claims());

    // Rather than minting a second app user for someone who already has one.
    await expect(signUp(t, claims())).rejects.toThrow(/already\s+exists/i);

    const counts = await t.run(async (ctx: any) => ({
      accounts: (await ctx.db.query("accounts").collect()).length,
      sessions: (await ctx.db.query("sessions").collect()).length,
    }));
    expect(counts).toEqual({ accounts: 1, sessions: 1 });
  });
});

describe("signIn", () => {
  test("reuses the existing account and mints a fresh session", async () => {
    const t = setup();
    const first = await signUp(t, claims({ profile: { name: "Alice" } }));
    const second = await signIn(t, claims({ profile: { name: "Alice 2.0" } }));

    expect(second.userId).toBe(first.userId);
    const { accounts, sessions } = await t.run(async (ctx: any) => ({
      accounts: (await ctx.db.query("accounts").collect()).length,
      sessions: (await ctx.db.query("sessions").collect()).length,
    }));
    // One account reused; a fresh session per sign-in.
    expect(accounts).toBe(1);
    expect(sessions).toBe(2);
  });

  test("invokes the app's onSignIn with the resolved user id and latest claims", async () => {
    const t = setup();
    const first = await signUp(t, claims({ profile: { name: "Alice" } }));
    await signIn(t, claims({ profile: { name: "Alice 2.0" } }));

    // createUser ran once, for the sign-up; onSignIn ran for both.
    expect(await createUserCalls(t)).toHaveLength(1);
    const calls = await onSignInCalls(t);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual({
      provider: { name: "password", accountId: "alice", profile: { name: "Alice 2.0" } },
      userId: first.userId,
    });
  });

  test("mints the session without notifying an app that attached no onSignIn", async () => {
    const t = setup();
    const first = await signUp(t, claims());
    const before = (await onSignInCalls(t)).length;

    // No `onSignInHandle` is what an app that left `onSignIn` out sends.
    const bundle: TokenBundle = await t.mutation(api.public.signIn, { claims: claims() });

    expect(bundle.userId).toBe(first.userId);
    expect(await onSignInCalls(t)).toHaveLength(before);
  });

  test("refuses to sign in an identity with no account", async () => {
    const t = setup();
    // A miss means the method's records and the core's diverged, and creating a user here would paper over that.
    await expect(signIn(t, claims())).rejects.toThrow(/must go through signUp/i);
    expect(await sessionCount(t)).toBe(0);
  });
});

describe("signUpWithoutSession", () => {
  test("creates the user and the account, but no session", async () => {
    const t = setup();
    const { userId } = await t.mutation(api.public.signUpWithoutSession, {
      claims: claims(),
      createUserHandle: CREATE_USER_HANDLE,
    });

    const account = await t.run((ctx: any) => ctx.db.query("accounts").unique());
    expect(account?.userId).toBe(userId);
    expect(await createUserCalls(t)).toHaveLength(1);
    // No sign-in happened, so onSignIn does not run.
    expect(await onSignInCalls(t)).toHaveLength(0);

    const counts = await t.run(async (ctx: any) => ({
      accounts: (await ctx.db.query("accounts").collect()).length,
      sessions: (await ctx.db.query("sessions").collect()).length,
    }));
    expect(counts).toEqual({ accounts: 1, sessions: 0 });
  });

  test("a later signIn resolves the same user and mints a session", async () => {
    const t = setup();
    const { userId } = await t.mutation(api.public.signUpWithoutSession, {
      claims: claims(),
      createUserHandle: CREATE_USER_HANDLE,
    });

    const bundle = await signIn(t, claims());
    expect(bundle.userId).toBe(userId);
    const counts = await t.run(async (ctx: any) => ({
      accounts: (await ctx.db.query("accounts").collect()).length,
      sessions: (await ctx.db.query("sessions").collect()).length,
    }));
    expect(counts).toEqual({ accounts: 1, sessions: 1 });
  });

  test("keys the account by the minted user id with USE_USER_ID_AS_ACCOUNT_ID", async () => {
    const t = setup();
    const { userId } = await t.mutation(api.public.signUpWithoutSession, {
      claims: claims({ providerAccountId: USE_USER_ID_AS_ACCOUNT_ID, profile: { email: "alice@example.com" } }),
      createUserHandle: CREATE_USER_HANDLE,
    });

    // The account's identifier is the user id the app minted, so a later sign-in passing it resolves the same user.
    const bundle = await signIn(t, claims({ providerAccountId: userId }));
    expect(bundle.userId).toBe(userId);
    const accounts = await t.run(async (ctx: any) => await ctx.db.query("accounts").collect());
    expect(accounts).toHaveLength(1);
    expect(accounts[0].providerAccountId).toBe(userId);
  });

  test("refuses an identity that already has an account", async () => {
    const t = setup();
    await signUp(t, claims());

    await expect(
      t.mutation(api.public.signUpWithoutSession, { claims: claims(), createUserHandle: CREATE_USER_HANDLE }),
    ).rejects.toThrow(/already\s+exists/i);
    expect(await t.run(async (ctx: any) => (await ctx.db.query("accounts").collect()).length)).toBe(1);
  });
});

describe("refresh", () => {
  test("rotates the refresh token and mints a fresh access token", async () => {
    const t = setup();
    const bundle = await signUp(t, claims());

    const rotated = expectRotated(await refresh(t, bundle.refreshToken));
    expect(rotated.refreshToken).not.toBe(bundle.refreshToken);
    expect(rotated.userId).toBe(bundle.userId);

    // The newly minted refresh token works for the next rotation.
    const again = expectRotated(await refresh(t, rotated.refreshToken));
    expect(again.refreshToken).not.toBe(rotated.refreshToken);
  });

  test("sign-in issues a token that its first refresh redeems", async () => {
    const t = setup();
    const bundle = await signUp(t, claims());
    expect(await redeemedHash(t)).toBeUndefined();
    expect(await issuedHashes(t)).toEqual([await sha256Hex(bundle.refreshToken)]);

    const successor = expectRotated(await refresh(t, bundle.refreshToken));

    // Nothing is spent yet: had this answer been lost, the client would still hold a token that works.
    expect(await redeemedHash(t)).toBe(await sha256Hex(bundle.refreshToken));
    expect(await issuedHashes(t)).toEqual([await sha256Hex(successor.refreshToken)]);
    expect(await retiredHashes(t)).toEqual([]);
  });

  test("a refresh whose response was lost can be retried with the same token", async () => {
    const t = setup();
    const bundle = await signUp(t, claims());

    const lost = expectRotated(await refresh(t, bundle.refreshToken));
    // The client never saw `lost` and presents its token again.
    const retry = expectRotated(await refresh(t, bundle.refreshToken));
    expect(retry.refreshToken).not.toBe(lost.refreshToken);

    // The retry's successor carries on, and the lost one is dropped unused.
    expectRotated(await refresh(t, retry.refreshToken));
    expect(await sessionCount(t)).toBe(1);
    expect(await retiredTokens(t)).toEqual([
      { hash: await sha256Hex(bundle.refreshToken), state: "spent" },
      { hash: await sha256Hex(lost.refreshToken), state: "dropped" },
    ]);
  });

  test("first use of an issued token redeems it and spends the one before", async () => {
    const t = setup();
    const bundle = await signUp(t, claims());
    const successor = expectRotated(await refresh(t, bundle.refreshToken));

    const next = expectRotated(await refresh(t, successor.refreshToken));

    expect(await redeemedHash(t)).toBe(await sha256Hex(successor.refreshToken));
    expect(await issuedHashes(t)).toEqual([await sha256Hex(next.refreshToken)]);
    expect(await retiredTokens(t)).toEqual([{ hash: await sha256Hex(bundle.refreshToken), state: "spent" }]);
  });

  test("racers sharing the redeemed token each get an issued token", async () => {
    const t = setup();
    const bundle = await signUp(t, claims());

    const racers: TokenBundle[] = [];
    for (let i = 0; i < 3; i++) racers.push(expectRotated(await refresh(t, bundle.refreshToken)));
    expect(new Set(racers.map((r) => r.refreshToken)).size).toBe(3);

    // The client keeps whichever answer it saw last; that one is redeemed, and the others are dropped unpresented.
    expectRotated(await refresh(t, racers[2]!.refreshToken));
    expect(await sessionCount(t)).toBe(1);
    expect((await retiredTokens(t)).filter((r) => r.state === "dropped")).toHaveLength(2);
  });

  test("racers sharing an issued token both succeed", async () => {
    const t = setup();
    const bundle = await signUp(t, claims());
    const successor = expectRotated(await refresh(t, bundle.refreshToken));

    // Parallel server-rendered loaders carrying the same new cookie: the first redeems it, the second finds it redeemed.
    const first = expectRotated(await refresh(t, successor.refreshToken));
    const second = expectRotated(await refresh(t, successor.refreshToken));
    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect(await sessionCount(t)).toBe(1);
    expect(await redeemedHash(t)).toBe(await sha256Hex(successor.refreshToken));
  });

  test("reports no session and clears it once the refresh token has expired", async () => {
    const t = setup();
    const bundle = await signUp(t, claims());
    const successor = expectRotated(await refresh(t, bundle.refreshToken));

    // Force the redeemed token past its expiry.
    await t.run(async (ctx: any) => {
      const [redeemed] = (await ctx.db.query("refreshTokens").collect()).filter(
        (r: Doc<"refreshTokens">) => r.state === "redeemed",
      );
      await ctx.db.patch(redeemed._id, { expiresAt: Date.now() - 1000 });
    });

    expect((await refresh(t, bundle.refreshToken)).kind).toBe("noSession");
    // The dead session was removed in the same transaction, tokens and all.
    expect(await sessionCount(t)).toBe(0);
    expect((await refresh(t, successor.refreshToken)).kind).toBe("noSession");
  });

  test("reports no session for an expired issued token", async () => {
    const t = setup();
    const bundle = await signUp(t, claims());
    const successor = expectRotated(await refresh(t, bundle.refreshToken));

    await t.run(async (ctx: any) => {
      const [issued] = (await ctx.db.query("refreshTokens").collect()).filter(
        (r: Doc<"refreshTokens">) => r.state === "issued",
      );
      await ctx.db.patch(issued._id, { expiresAt: Date.now() - 1000 });
    });

    expect((await refresh(t, successor.refreshToken)).kind).toBe("noSession");
    expect(await sessionCount(t)).toBe(0);
    expect(await issuedHashes(t)).toEqual([]);
  });

  test("reports no session for an unknown refresh token", async () => {
    const t = setup();
    expect((await refresh(t, "not-a-real-token")).kind).toBe("noSession");
  });

  test("an unknown token revokes nothing", async () => {
    const t = setup();
    const bundle = await signUp(t, claims());

    expect((await refresh(t, "not-a-real-token")).kind).toBe("noSession");
    // Revoking on an unrecognized token would let anyone sign anyone else out with a made-up string.
    expect(await sessionCount(t)).toBe(1);
    expect(expectRotated(await refresh(t, bundle.refreshToken))).toBeTruthy();
  });
});

// `retiredAt` dates a retired hash, stamped from the clock: aging one past the horizon moves the deployment's clock.
describe("refresh-token reuse detection", () => {
  test("a lost response is recoverable after any gap", async () => {
    const t = setup();
    const bundle = await signUp(t, claims());

    // The refresh commits, then the laptop sleeps before the answer lands.
    expectRotated(await refresh(t, bundle.refreshToken));
    await t.advanceTime(2 * 60 * 60 * 1000);

    // Hours later, the token the client still holds is still redeemed.
    const recovered = expectRotated(await refresh(t, bundle.refreshToken));
    expectRotated(await refresh(t, recovered.refreshToken));
    expect(await sessionCount(t)).toBe(1);
  });

  test("a spent token revokes the session", async () => {
    const t = setup();
    const stolen = await signUp(t, claims());

    // The thief refreshes and uses its successor, which spends the token the victim holds.
    const thief = expectRotated(await refresh(t, stolen.refreshToken));
    const thiefNext = expectRotated(await refresh(t, thief.refreshToken));
    await t.advanceTime(60_000);

    expect((await refresh(t, stolen.refreshToken)).kind).toBe("noSession");
    expect(await sessionCount(t)).toBe(0);
    expect(await retiredHashes(t)).toEqual([]);
    expect(await issuedHashes(t)).toEqual([]);
    // Revocation is mutual: the thief's token stops working too.
    expect((await refresh(t, thiefNext.refreshToken)).kind).toBe("noSession");
  });

  test("a dropped token revokes the session", async () => {
    const t = setup();
    const stolen = await signUp(t, claims());

    // Thief and victim both refresh from the same token; the victim redeems first, which drops the thief's successor.
    const victim = expectRotated(await refresh(t, stolen.refreshToken));
    const thief = expectRotated(await refresh(t, stolen.refreshToken));
    const victimNext = expectRotated(await refresh(t, victim.refreshToken));

    // Whoever redeems second has forked from the first.
    expect((await refresh(t, thief.refreshToken)).kind).toBe("noSession");
    expect(await sessionCount(t)).toBe(0);
    expect((await refresh(t, victimNext.refreshToken)).kind).toBe("noSession");
  });

  test("detects a replay several rotations back", async () => {
    const t = setup();
    const stolen = await signUp(t, claims());

    // Retention is by age, so a thief who keeps rotating does not evict the victim's hash.
    let latest = stolen;
    for (let i = 0; i < 6; i++) latest = expectRotated(await refresh(t, latest.refreshToken));
    // Each rotation after the first spends the token redeemed before it.
    expect(await retiredHashes(t)).toHaveLength(5);
    await t.advanceTime(60_000);

    expect((await refresh(t, stolen.refreshToken)).kind).toBe("noSession");
    expect(await sessionCount(t)).toBe(0);
    expect((await refresh(t, latest.refreshToken)).kind).toBe("noSession");
  });

  test("a replay after the session is already gone is a no-op", async () => {
    const t = setup();
    const bundle = await signUp(t, claims());
    const rotated = expectRotated(await refresh(t, bundle.refreshToken));
    expectRotated(await refresh(t, rotated.refreshToken));
    await t.mutation(api.public.signOut, { refreshToken: rotated.refreshToken });

    // Two replays racing each other both resolve a session the other deleted.
    expect((await refresh(t, bundle.refreshToken)).kind).toBe("noSession");
  });

  test("pruning retires spent hashes, and with them the detection", async () => {
    const t = setup();
    const stolen = await signUp(t, claims());
    const live = expectRotated(await refresh(t, stolen.refreshToken));
    const next = expectRotated(await refresh(t, live.refreshToken));
    expect(await retiredHashes(t)).toEqual([await sha256Hex(stolen.refreshToken)]);

    await t.advanceTime(SPENT_TOKEN_HORIZON_MS + 1);
    // The next redemption pays for the row it adds by erasing the expired one.
    const after = expectRotated(await refresh(t, next.refreshToken));
    expect(await retiredHashes(t)).toEqual([await sha256Hex(live.refreshToken)]);

    // Past the horizon the stolen token is merely unknown, so it revokes nothing.
    expect((await refresh(t, stolen.refreshToken)).kind).toBe("noSession");
    expect(await sessionCount(t)).toBe(1);
    expectRotated(await refresh(t, after.refreshToken));
  });

  test(`revokes the session at the standard limit of ${STANDARD_ISSUED_REFRESH_TOKEN_LIMIT} issued tokens`, async () => {
    const t = setup();
    const bundle = await signUp(t, claims());

    for (let i = 0; i < STANDARD_ISSUED_REFRESH_TOKEN_LIMIT; i++) {
      expectRotated(await refresh(t, bundle.refreshToken));
      await t.advanceTime(REFRESH_GRACE_MS + 1);
    }

    // That many lost answers in a row looks more like someone replaying the redeemed token than a bad network.
    const { result, warnings } = await warningsOf(() => refresh(t, bundle.refreshToken));
    expect(result.kind).toBe("noSession");
    expect(warnings.join("\n")).toContain(
      `Refresh token used with at least ${STANDARD_ISSUED_REFRESH_TOKEN_LIMIT} issued tokens never redeemed: deleting the associated session.`,
    );
    expect(await sessionCount(t)).toBe(0);
    expect(await issuedHashes(t)).toEqual([]);
  });

  test("redeeming an issued token resets the count", async () => {
    const t = setup();
    let token = (await signUp(t, claims())).refreshToken;

    for (let round = 0; round < 3; round++) {
      let last: TokenBundle | undefined;
      for (let i = 0; i < STANDARD_ISSUED_REFRESH_TOKEN_LIMIT; i++) {
        last = expectRotated(await refresh(t, token));
        await t.advanceTime(REFRESH_GRACE_MS + 1);
      }
      token = last!.refreshToken;
    }
    expect(await sessionCount(t)).toBe(1);
  });

  test("concurrent refreshes right after a redemption don't count", async () => {
    const t = setup();
    const bundle = await signUp(t, claims());

    // A server-rendered page load: more requests carrying one cookie than the cap, at once. The first redeems the
    // token, the rest present it redeemed.
    const burst = await Promise.all(
      Array.from({ length: STANDARD_ISSUED_REFRESH_TOKEN_LIMIT + 3 }, () => refresh(t, bundle.refreshToken)),
    );
    burst.forEach(expectRotated);
    expect(await sessionCount(t)).toBe(1);

    // Whichever answer the browser kept carries on as usual.
    await t.advanceTime(60_000);
    expectRotated(await refresh(t, expectRotated(burst.at(-1)!).refreshToken));
    expect(await sessionCount(t)).toBe(1);
  });

  test("the grace doesn't extend past the redemption", async () => {
    const t = setup();
    const bundle = await signUp(t, claims());
    expectRotated(await refresh(t, bundle.refreshToken));

    // Replays spaced inside the grace from each other still run out, since the grace counts from the redemption.
    const results: RefreshResult["kind"][] = [];
    for (let i = 0; i < 10; i++) {
      await t.advanceTime(REFRESH_GRACE_MS - 1000);
      const result = await refresh(t, bundle.refreshToken);
      results.push(result.kind);
      if (result.kind === "noSession") break;
    }
    expect(results.at(-1)).toBe("noSession");
    expect(await sessionCount(t)).toBe(0);
  });

  test("a spent or dropped token warns as it revokes", async () => {
    const t = setup();
    const bundle = await signUp(t, claims());
    const victim = expectRotated(await refresh(t, bundle.refreshToken));
    const thief = expectRotated(await refresh(t, bundle.refreshToken));
    expectRotated(await refresh(t, victim.refreshToken));

    const { warnings } = await warningsOf(() => refresh(t, thief.refreshToken));
    expect(warnings.join("\n")).toContain(
      "Dropped refresh token used: a sibling was already redeemed, so the session has forked. Deleting the associated " +
        "session. This could be due to a bug or a leaked refresh token.",
    );
  });
});

describe("signOut", () => {
  test("revokes the session so it can no longer be refreshed", async () => {
    const t = setup();
    const bundle = await signUp(t, claims());

    await t.mutation(api.public.signOut, { refreshToken: bundle.refreshToken });
    expect(await sessionCount(t)).toBe(0);
    expect((await refresh(t, bundle.refreshToken)).kind).toBe("noSession");
  });

  test("revokes when given an issued token", async () => {
    const t = setup();
    const bundle = await signUp(t, claims());
    const rotated = expectRotated(await refresh(t, bundle.refreshToken));

    // What a client holds between refreshes: the issued token it hasn't used yet.
    await t.mutation(api.public.signOut, { refreshToken: rotated.refreshToken });
    expect(await sessionCount(t)).toBe(0);
    expect(await issuedHashes(t)).toEqual([]);
    expect((await refresh(t, bundle.refreshToken)).kind).toBe("noSession");
  });

  test("revokes when given a spent token", async () => {
    const t = setup();
    const bundle = await signUp(t, claims());
    const rotated = expectRotated(await refresh(t, bundle.refreshToken));
    const next = expectRotated(await refresh(t, rotated.refreshToken));

    // A tab signing out just after a sibling refreshed presents the token it still holds.
    await t.mutation(api.public.signOut, { refreshToken: bundle.refreshToken });
    expect(await sessionCount(t)).toBe(0);
    expect(await retiredHashes(t)).toEqual([]);
    expect((await refresh(t, next.refreshToken)).kind).toBe("noSession");
  });

  test("erases the session's refresh tokens along with it", async () => {
    const t = setup();
    const bundle = await signUp(t, claims());
    const rotated = expectRotated(await refresh(t, bundle.refreshToken));
    const next = expectRotated(await refresh(t, rotated.refreshToken));
    expect(await retiredHashes(t)).toHaveLength(1);
    expect(await issuedHashes(t)).toHaveLength(1);

    await t.mutation(api.public.signOut, { refreshToken: next.refreshToken });
    // A refresh token must never outlive the session it names.
    expect(await retiredHashes(t)).toEqual([]);
    expect(await issuedHashes(t)).toEqual([]);
  });

  test("is idempotent — signing out an already-revoked token does not throw", async () => {
    const t = setup();
    const bundle = await signUp(t, claims());

    await t.mutation(api.public.signOut, { refreshToken: bundle.refreshToken });
    expect(await t.mutation(api.public.signOut, { refreshToken: bundle.refreshToken })).toBeNull();
  });
});

describe("listSessions", () => {
  test("lists every session of the user", async () => {
    const t = setup();
    const bundle = await signUp(t, claims());
    const otherBundle = await signIn(t, claims());

    const sessions = await t.query(api.public.listSessions, { userId: bundle.userId });
    expect(sessions.map((s: { sessionId: string }) => s.sessionId).sort()).toEqual(
      [sessionIdOf(bundle), sessionIdOf(otherBundle)].sort(),
    );
  });

  test("lists the newest session first", async () => {
    const t = setup();
    const first = await signUp(t, claims());
    const second = await signIn(t, claims());
    const third = await signIn(t, claims());

    const sessions = await t.query(api.public.listSessions, { userId: first.userId });
    expect(sessions.map((s: { sessionId: string }) => s.sessionId)).toEqual([third, second, first].map(sessionIdOf));
  });

  test("lists only the sessions of the given user", async () => {
    const t = setup();
    const aliceBundle = await signUp(t, claims());
    await signUp(t, claims({ providerAccountId: "bob" }));

    const sessions = await t.query(api.public.listSessions, { userId: aliceBundle.userId });
    expect(sessions.map((s: { sessionId: string }) => s.sessionId)).toEqual([sessionIdOf(aliceBundle)]);
  });

  test("reports when the session's newest refresh token was issued and when it expires", async () => {
    const t = setup();
    const bundle = await signUp(t, claims());
    await t.advanceTime(60_000);
    const refreshedAt = t.now();
    const rotated = expectRotated(await refresh(t, bundle.refreshToken));

    const sessions = await t.query(api.public.listSessions, { userId: bundle.userId });
    expect(sessions).toEqual([
      {
        sessionId: sessionIdOf(rotated),
        creationTime: expect.any(Number),
        lastRefreshedAt: expect.any(Number),
        expiresAt: rotated.refreshTokenExpiresAt,
      },
    ]);
    // A `_creationTime` is its transaction's start time, the next float up for each further insert (as Convex's
    // backend; convex-test's is `Date.now()`).
    expect(Math.floor(sessions[0].lastRefreshedAt)).toBe(refreshedAt);
    expect(rotated.refreshTokenExpiresAt).toBeGreaterThan(bundle.refreshTokenExpiresAt);
  });

  test("includes a session whose refresh tokens have all expired", async () => {
    const t = setup();
    const bundle = await signUp(t, claims());
    const shortLived: TokenBundle = await t.mutation(api.public.signIn, {
      claims: claims(),
      refreshTokenTtlSeconds: 60 * 60,
    });
    await t.advanceTime(2 * 60 * 60 * 1000);

    const sessions = await t.query(api.public.listSessions, { userId: bundle.userId });
    const expired = sessions.find((s: { sessionId: string }) => s.sessionId === sessionIdOf(shortLived));
    expect(expired?.expiresAt).toBe(shortLived.refreshTokenExpiresAt);
    expect(expired.expiresAt).toBeLessThan(t.now());
    expect(sessions).toHaveLength(2);
  });

  test("leaves out, with a warning, a session with no issued token", async () => {
    const t = setup();
    const bundle = await signUp(t, claims());
    const otherBundle = await signIn(t, claims());
    // Not a state the token lifecycle reaches; forced here to cover the guard.
    await t.run(async (ctx: any) => {
      const tokens = await ctx.db
        .query("refreshTokens")
        .withIndex("by_session_state", (q: any) => q.eq("sessionId", sessionIdOf(otherBundle) as Id<"sessions">))
        .collect();
      for (const row of tokens) await ctx.db.delete(row._id);
    });

    const { result: sessions, warnings } = await warningsOf(() =>
      t.query(api.public.listSessions, { userId: bundle.userId }),
    );
    expect(sessions.map((s: { sessionId: string }) => s.sessionId)).toEqual([sessionIdOf(bundle)]);
    expect(warnings.join("\n")).toContain("has no issued refresh token");
  });

  test("returns nothing for a user with no sessions", async () => {
    const t = setup();
    expect(await t.query(api.public.listSessions, { userId: "nobody" })).toEqual([]);
  });
});

describe("revokeSessions", () => {
  test("revokes the sessions so they can no longer be refreshed", async () => {
    const t = setup();
    const bundle = await signUp(t, claims());
    const second = await signIn(t, claims());
    const third = await signIn(t, claims());

    const revoked: string[] = await t.mutation(api.public.revokeSessions, {
      sessionIds: [sessionIdOf(second), sessionIdOf(third)],
    });
    expect(revoked.sort()).toEqual([sessionIdOf(second), sessionIdOf(third)].sort());
    expect(await sessionCount(t)).toBe(1);
    expect((await refresh(t, second.refreshToken)).kind).toBe("noSession");
    expect((await refresh(t, third.refreshToken)).kind).toBe("noSession");
    expect((await refresh(t, bundle.refreshToken)).kind).toBe("rotated");
  });

  test("revokes the sessions of any user", async () => {
    const t = setup();
    const alice = await signUp(t, claims());
    const bob = await signUp(t, claims({ providerAccountId: "bob" }));

    const revoked = await t.mutation(api.public.revokeSessions, { sessionIds: [sessionIdOf(alice), sessionIdOf(bob)] });
    expect(revoked).toHaveLength(2);
    expect(await sessionCount(t)).toBe(0);
  });

  test("erases the sessions' refresh tokens", async () => {
    const t = setup();
    const bundle = await signUp(t, claims());
    expectRotated(await refresh(t, bundle.refreshToken));

    await t.mutation(api.public.revokeSessions, { sessionIds: [sessionIdOf(bundle)] });
    expect(await t.run(async (ctx: any) => await ctx.db.query("refreshTokens").collect())).toEqual([]);
  });

  test("skips an already-revoked session id", async () => {
    const t = setup();
    const bundle = await signUp(t, claims());
    const otherBundle = await signIn(t, claims());
    await t.mutation(api.public.signOut, { refreshToken: bundle.refreshToken });

    expect(
      await t.mutation(api.public.revokeSessions, { sessionIds: [sessionIdOf(bundle), sessionIdOf(otherBundle)] }),
    ).toEqual([sessionIdOf(otherBundle)]);
    expect(await sessionCount(t)).toBe(0);
  });

  test("reports a repeated session id once", async () => {
    const t = setup();
    const bundle = await signUp(t, claims());

    expect(
      await t.mutation(api.public.revokeSessions, { sessionIds: [sessionIdOf(bundle), sessionIdOf(bundle)] }),
    ).toEqual([sessionIdOf(bundle)]);
  });

  test("skips a malformed session id", async () => {
    const t = setup();
    await signUp(t, claims());

    expect(await t.mutation(api.public.revokeSessions, { sessionIds: ["not a session id"] })).toEqual([]);
    expect(await sessionCount(t)).toBe(1);
  });

  test("revokes nothing for no ids", async () => {
    const t = setup();
    await signUp(t, claims());

    expect(await t.mutation(api.public.revokeSessions, { sessionIds: [] })).toEqual([]);
    expect(await sessionCount(t)).toBe(1);
  });
});

describe("token lifetime configuration", () => {
  test("honors a custom access-token TTL on sign-up", async () => {
    const t = setup();
    const before = t.now();
    const bundle: TokenBundle = await t.mutation(api.public.signUp, {
      claims: claims(),
      createUserHandle: CREATE_USER_HANDLE,
      accessTokenTtlSeconds: 300,
    });
    // The JWT `exp` is floored to the second, so allow a small window.
    const expMs = decodeJwt(bundle.accessToken).exp! * 1000;
    expect(expMs).toBeGreaterThanOrEqual(before + 300_000 - 1000);
    expect(expMs).toBeLessThanOrEqual(t.now() + 300_000);
  });

  test("honors a custom refresh-token TTL on sign-up and on rotation", async () => {
    const t = setup();
    const oneHourSeconds = 60 * 60;
    const oneHourMs = oneHourSeconds * 1000;

    const before = t.now();
    const bundle: TokenBundle = await t.mutation(api.public.signUp, {
      claims: claims(),
      createUserHandle: CREATE_USER_HANDLE,
      refreshTokenTtlSeconds: oneHourSeconds,
    });
    expect(bundle.refreshTokenExpiresAt).toBeGreaterThanOrEqual(before + oneHourMs);
    // A transaction's time is its start, floored at its snapshot (as Convex's), so it may be a millisecond past the clock's.
    expect(bundle.refreshTokenExpiresAt).toBeLessThanOrEqual(t.now() + oneHourMs + 1000);

    // The rotated token gets the configured lifetime too.
    const rotated = expectRotated(
      await t.mutation(api.public.refresh, {
        refreshToken: bundle.refreshToken,
        refreshTokenTtlSeconds: oneHourSeconds,
      }),
    );
    expect(rotated.refreshTokenExpiresAt).toBeLessThanOrEqual(t.now() + oneHourMs + 1000);
  });

  test("rejects a configuration where the access TTL is not shorter than the refresh TTL", async () => {
    const t = setup();
    await expect(
      t.mutation(api.public.signUp, {
        claims: claims(),
        createUserHandle: CREATE_USER_HANDLE,
        accessTokenTtlSeconds: 100,
        refreshTokenTtlSeconds: 1,
      }),
    ).rejects.toThrow(/shorter than the refresh-token TTL/i);
  });

  test("rejects a non-positive TTL and an access TTL over an hour", async () => {
    const t = setup();
    const signUpWith = (ttl: { accessTokenTtlSeconds?: number; refreshTokenTtlSeconds?: number }) =>
      t.mutation(api.public.signUp, { claims: claims(), createUserHandle: CREATE_USER_HANDLE, ...ttl });
    await expect(signUpWith({ accessTokenTtlSeconds: 0 })).rejects.toThrow("Token TTLs must be positive.");
    await expect(signUpWith({ accessTokenTtlSeconds: 3601 })).rejects.toThrow(
      "Access-token TTL must be at most one hour (the deployment refuses to sign a longer-lived JWT).",
    );
  });
});

describe("getUserIdByAccount", () => {
  test("returns null for an unknown identity", async () => {
    const t = setup();
    expect(
      await t.query(api.public.getUserIdByAccount, { provider: "password", providerAccountId: "alice" }),
    ).toBeNull();
  });

  test("returns the user id after the account is created by signUp", async () => {
    const t = setup();
    const bundle = await signUp(t, claims());
    expect(await t.query(api.public.getUserIdByAccount, { provider: "password", providerAccountId: "alice" })).toBe(
      bundle.userId,
    );
  });

  test("does not confuse identities across methods", async () => {
    const t = setup();
    await signUp(t, claims({ providerName: "password", providerAccountId: "alice" }));
    expect(await t.query(api.public.getUserIdByAccount, { provider: "google", providerAccountId: "alice" })).toBeNull();
  });
});

describe("getSession", () => {
  test("returns the user id while the session is live", async () => {
    const t = setup();
    const bundle = await signUp(t, claims());
    expect(await t.query(api.public.getSession, { sessionId: sessionIdOf(bundle) })).toEqual({
      userId: bundle.userId,
    });
  });

  test("keeps answering for the same session across a refresh", async () => {
    const t = setup();
    const bundle = await signUp(t, claims());
    const rotated = expectRotated(await refresh(t, bundle.refreshToken));
    // The refreshed access token names the same session.
    expect(sessionIdOf(rotated)).toBe(sessionIdOf(bundle));
    expect(await t.query(api.public.getSession, { sessionId: sessionIdOf(bundle) })).toEqual({
      userId: bundle.userId,
    });
  });

  test("returns null once the session is revoked", async () => {
    const t = setup();
    const bundle = await signUp(t, claims());
    await t.mutation(api.public.signOut, { refreshToken: bundle.refreshToken });
    expect(await t.query(api.public.getSession, { sessionId: sessionIdOf(bundle) })).toBeNull();
  });

  test("returns null for a string that is not a session id", async () => {
    const t = setup();
    await signUp(t, claims());
    expect(await t.query(api.public.getSession, { sessionId: "not-a-session-id" })).toBeNull();
  });

  test("returns null for an id in another table", async () => {
    const t = setup();
    await signUp(t, claims());
    const accountId = await t.run(async (ctx: any) => (await ctx.db.query("accounts").unique())!._id);
    expect(await t.query(api.public.getSession, { sessionId: accountId })).toBeNull();
  });
});
