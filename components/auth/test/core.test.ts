// The core component's suite (STUDY-201 §3.4, STUDY-208 §5), upstream's `component/core.test.ts` at v2.0.0, ported to
// `@bunvex/testing`: the component's functions pushed as an app's (fixtures/standalone), as upstream runs them, so
// `t.run` reads its tables. Vitest's fake timers are the deployment's virtual clock (`t.advanceTime`), and
// `finishScheduledFunctions` its `finishAllScheduledFunctions`; the app callbacks' spies are a table the fixture writes
// (they run in the deployment, not in the test's process); tokens are verified with `jose` against `t.jwks()`, the
// issuer being the deployment's origin. Upstream's `transactionLimits: true` needs no counterpart: bunvex always
// enforces them.
// biome-ignore-all lint/suspicious/noExplicitAny: the app's api and the inline functions' ctx are untyped
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { anyApi } from "@bunvex/server";
import { bunvexTest, type TestBunvex } from "@bunvex/testing";
import { createLocalJWKSet, decodeJwt, jwtVerify } from "jose";
import type { Doc, Id } from "../src/component/_generated/dataModel.ts";
import {
  MAX_SESSIONS_PER_USER,
  REFRESH_GRACE_MS,
  SPENT_TOKEN_HORIZON_MS,
  STANDARD_ISSUED_REFRESH_TOKEN_LIMIT,
} from "../src/component/sessions.ts";
import { sha256Hex } from "../src/lib/crypto.ts";
import { resolveTtlConfig } from "../src/lib/ttl.ts";
import type { AuthClaims, RefreshResult, TokenBundle } from "../src/lib/types.ts";

const api = anyApi as any;
const STANDALONE = join(import.meta.dir, "fixtures", "standalone");
const AUDIENCE = "bunvex-auth";
const CREATE_USER_HANDLE = "testApp:createUser";
/** The path of the component that authenticated the users of the tests. */
const COMPONENT_PATH = "authPassword";
const ON_SIGN_IN_HANDLE = "testApp:onSignIn";
const THROWING_ON_SIGN_IN_HANDLE = "testApp:onSignInThatThrows";

const open: TestBunvex[] = [];
afterEach(async () => {
  for (const t of open.splice(0)) await t.close();
});
// Each test pushes a deployment of its own; under a full `bun run check` a push can take past the default 5 s.
setDefaultTimeout(60_000);

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
  return { method: "usernamePassword", profile: { name: "Alice" }, ...overrides };
}

/** The lifetimes `setupAuth` passes when the app overrides the given ones: the component always gets all three. */
function ttl(overrides: Parameters<typeof resolveTtlConfig>[0] = {}) {
  return resolveTtlConfig(overrides);
}

/** The lifetimes `setupAuth` passes when the app overrides none. */
const DEFAULT_TTL = ttl();
const HOUR_MS = 60 * 60 * 1000;
const DAYS_31_MS = 31 * 24 * HOUR_MS;

/** Run the scheduled functions to completion, such as the erasure of a deleted session's refresh tokens. */
async function finishScheduledFunctions(t: TestBunvex): Promise<void> {
  await t.finishAllScheduledFunctions();
}

const createUserCalls = (t: TestBunvex) => t.query(api.testApp.calls, { kind: "createUser" }) as Promise<unknown[]>;
const onSignInCalls = (t: TestBunvex) => t.query(api.testApp.calls, { kind: "onSignIn" }) as Promise<unknown[]>;

/** Establish a brand new identity: its app user and a session. */
async function signUp(t: TestBunvex, c: AuthClaims): Promise<TokenBundle> {
  return await t.mutation(api.public._internal_dangerous_signUp, {
    claims: c,
    componentPath: COMPONENT_PATH,
    createUserHandle: CREATE_USER_HANDLE,
    onSignInHandle: ON_SIGN_IN_HANDLE,
    ...DEFAULT_TTL,
  });
}

/** Sign a known identity back in, as an app that attached an `onSignIn` does. */
async function signIn(t: TestBunvex, c: AuthClaims, userId: string): Promise<TokenBundle> {
  return await t.mutation(api.public._internal_dangerous_signIn, {
    claims: c,
    componentPath: COMPONENT_PATH,
    userId,
    onSignInHandle: ON_SIGN_IN_HANDLE,
    ...DEFAULT_TTL,
  });
}

/** Assert a refresh rotated the token, and narrow to the new bundle. */
function expectRotated(result: RefreshResult): TokenBundle {
  expect(result.kind).toBe("rotated");
  return (result as Extract<RefreshResult, { kind: "rotated" }>).tokens;
}

/** Exchange a refresh token, as a client rotating its session does. */
async function refresh(t: TestBunvex, refreshToken: string): Promise<RefreshResult> {
  return await t.mutation(api.public.refresh, { refreshToken, ...DEFAULT_TTL });
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

describe("sessions and created user IDs", () => {
  const createdUserIds = async (t: TestBunvex): Promise<string[]> =>
    (await t.run(async (ctx: any) => await ctx.db.query("createdUserIds").collect())).map(
      (row: { userId: string }) => row.userId,
    );

  test("a session records the path of the component that authenticated the user", async () => {
    const t = setup();
    const bundle = await signUp(t, claims());
    const { payload } = await verifyAccessToken(t, bundle.accessToken);
    const session = await t.run((ctx: any) => ctx.db.get(payload.sub as Id<"sessions">));
    expect(session).toMatchObject({ component: COMPONENT_PATH });
  });

  test("signUp, signIn, and signUpWithoutSession record the user ID once", async () => {
    const t = setup();
    const { userId } = await signUp(t, claims());
    await signIn(t, claims(), userId);
    await signIn(t, claims(), "someone");
    const { userId: pending } = await t.mutation(api.public._internal_dangerous_signUpWithoutSession, {
      claims: claims(),
      createUserHandle: CREATE_USER_HANDLE,
    });
    expect((await createdUserIds(t)).sort()).toEqual([userId, "someone", pending].sort());
  });

  test("markUserIdCreated records a user ID once, and refuses an empty one", async () => {
    const t = setup();
    await t.mutation(api.public.markUserIdCreated, { userId: "imported" });
    await t.mutation(api.public.markUserIdCreated, { userId: "imported" });
    expect(await createdUserIds(t)).toEqual(["imported"]);
    await expect(t.mutation(api.public.markUserIdCreated, { userId: "" })).rejects.toThrow(
      "Cannot mark an empty user ID as created.",
    );
  });
});

describe("signUp", () => {
  test("creates a session and mints a verifiable JWT", async () => {
    const t = setup();
    const bundle = await signUp(t, claims());

    expect(bundle.userId).toBeTruthy();
    expect(bundle.refreshToken).toBeTruthy();

    const session = await t.run(async (ctx: any) => await ctx.db.query("sessions").unique());
    expect(session).not.toBeNull();
    // The session holds the user id and the path of the component that authenticated the user, and nothing else about
    // the identity.
    expect(session).toMatchObject({ userId: bundle.userId, component: COMPONENT_PATH });

    // The access token verifies against the deployment's JWKS with the right claims. The subject is the session, not
    // the user: the app resolves the user through the session.
    const { payload } = await verifyAccessToken(t, bundle.accessToken);
    expect(payload.sub).toBe(session._id);
    expect(payload.exp! * 1000).toBeGreaterThan(t.now());
    expect(bundle.refreshTokenExpiresAt).toBeGreaterThan(payload.exp! * 1000);
  });

  test("invokes the app's createUser with the claims, then onSignIn", async () => {
    const t = setup();
    const bundle = await signUp(t, claims({ profile: { name: "Alice" } }));

    expect(await createUserCalls(t)).toEqual([{ method: { name: "usernamePassword", profile: { name: "Alice" } } }]);
    // A first sign-in is still a sign-in, so onSignIn runs too, with the id createUser just returned.
    expect(await onSignInCalls(t)).toEqual([
      { method: { name: "usernamePassword", profile: { name: "Alice" } }, userId: bundle.userId },
    ]);
  });

  test("creates the user without an onSignIn attached", async () => {
    const t = setup();
    const bundle: TokenBundle = await t.mutation(api.public._internal_dangerous_signUp, {
      claims: claims(),
      componentPath: COMPONENT_PATH,
      createUserHandle: CREATE_USER_HANDLE,
      ...DEFAULT_TTL,
    });

    // The bundle carries the id the app's createUser returned.
    expect(bundle.userId).toBe("user1");
    expect(await createUserCalls(t)).toHaveLength(1);
    expect(await onSignInCalls(t)).toHaveLength(0);
  });

  test("an onSignIn that throws rolls back the user it just created", async () => {
    const t = setup();
    await expect(
      t.mutation(api.public._internal_dangerous_signUp, {
        claims: claims(),
        componentPath: COMPONENT_PATH,
        createUserHandle: CREATE_USER_HANDLE,
        onSignInHandle: THROWING_ON_SIGN_IN_HANDLE,
        ...DEFAULT_TTL,
      }),
    ).rejects.toThrow(/no sign-ins for you/);

    // The app's rows are writes of the same mutation, so they roll back with it (the fixture logs createUser's call in
    // a table: it is gone). The session was never reached, since onSignIn runs before it is minted, and the user id
    // recorded before onSignIn rolled back too.
    const counts = await t.run(async (ctx: any) => ({
      createdUserIds: (await ctx.db.query("createdUserIds").collect()).length,
      sessions: (await ctx.db.query("sessions").collect()).length,
    }));
    expect(counts).toEqual({ createdUserIds: 0, sessions: 0 });
    expect(await createUserCalls(t)).toHaveLength(0);
  });
});

describe("signIn", () => {
  test("mints a fresh session for the given user", async () => {
    const t = setup();
    const first = await signUp(t, claims({ profile: { name: "Alice" } }));
    const second = await signIn(t, claims({ profile: { name: "Alice 2.0" } }), first.userId);

    expect(second.userId).toBe(first.userId);
    const sessions = await t.run(async (ctx: any) => await ctx.db.query("sessions").collect());
    expect(sessions.map(({ userId, component }: Doc<"sessions">) => ({ userId, component }))).toEqual([
      { userId: first.userId, component: COMPONENT_PATH },
      { userId: first.userId, component: COMPONENT_PATH },
    ]);
  });

  test("invokes the app's onSignIn with the resolved user id and latest claims", async () => {
    const t = setup();
    const first = await signUp(t, claims({ profile: { name: "Alice" } }));
    await signIn(t, claims({ profile: { name: "Alice 2.0" } }), first.userId);

    // createUser ran once, for the sign-up; onSignIn ran for both.
    expect(await createUserCalls(t)).toHaveLength(1);
    const calls = await onSignInCalls(t);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual({
      method: { name: "usernamePassword", profile: { name: "Alice 2.0" } },
      userId: first.userId,
    });
  });

  test("mints the session without notifying an app that attached no onSignIn", async () => {
    const t = setup();
    const first = await signUp(t, claims());
    const before = (await onSignInCalls(t)).length;

    // No `onSignInHandle` is what an app that left `onSignIn` out sends.
    const bundle: TokenBundle = await t.mutation(api.public._internal_dangerous_signIn, {
      claims: claims(),
      componentPath: COMPONENT_PATH,
      userId: first.userId,
      ...DEFAULT_TTL,
    });

    expect(bundle.userId).toBe(first.userId);
    expect(await onSignInCalls(t)).toHaveLength(before);
  });

  test("refuses an empty user id", async () => {
    const t = setup();
    // An empty string must never be accepted as a user id.
    await expect(signIn(t, claims(), "")).rejects.toThrow("Cannot sign in: no user id was given.");
    expect(await sessionCount(t)).toBe(0);
  });
});

describe("signUpWithoutSession", () => {
  test("creates the user, but no session", async () => {
    const t = setup();
    const { userId } = await t.mutation(api.public._internal_dangerous_signUpWithoutSession, {
      claims: claims(),
      createUserHandle: CREATE_USER_HANDLE,
    });

    // The id the app's createUser returned.
    expect(userId).toBe("user1");
    expect(await createUserCalls(t)).toHaveLength(1);
    // No sign-in happened, so onSignIn does not run, and no session was minted.
    expect(await onSignInCalls(t)).toHaveLength(0);
    expect(await sessionCount(t)).toBe(0);
  });

  test("a later signIn with the user id mints a session", async () => {
    const t = setup();
    const { userId } = await t.mutation(api.public._internal_dangerous_signUpWithoutSession, {
      claims: claims(),
      createUserHandle: CREATE_USER_HANDLE,
    });

    const bundle = await signIn(t, claims(), userId);
    expect(bundle.userId).toBe(userId);
    expect(await sessionCount(t)).toBe(1);
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

    // Past the default 30-day inactivity timeout.
    await t.advanceTime(DAYS_31_MS);

    expect((await refresh(t, bundle.refreshToken)).kind).toBe("noSession");
    // The dead session was removed in the same transaction.
    expect(await sessionCount(t)).toBe(0);
    expect((await refresh(t, successor.refreshToken)).kind).toBe("noSession");
  });

  test("reports no session for an expired issued token", async () => {
    const t = setup();
    const bundle = await signUp(t, claims());
    const successor = expectRotated(await refresh(t, bundle.refreshToken));

    // Past the default 30-day inactivity timeout.
    await t.advanceTime(DAYS_31_MS);

    expect((await refresh(t, successor.refreshToken)).kind).toBe("noSession");
    expect(await sessionCount(t)).toBe(0);
    await finishScheduledFunctions(t);
    expect(await issuedHashes(t)).toEqual([]);
  });

  test("a lowered inactivity timeout expires tokens issued under the old one", async () => {
    const t = setup();
    // Issued under the default 30-day inactivity timeout.
    const bundle = await signUp(t, claims());
    await t.advanceTime(2 * HOUR_MS);

    // Two hours old: dead under a one-hour inactivity timeout, though the 30-day one it was issued under has days to go.
    const result = await t.mutation(api.public.refresh, {
      refreshToken: bundle.refreshToken,
      ...ttl({ refreshInactivityTimeoutSeconds: 60 * 60 }),
    });
    expect(result.kind).toBe("noSession");
    expect(await sessionCount(t)).toBe(0);
  });

  test("a lowered inactivity timeout expires the redeemed token a retry would present", async () => {
    const t = setup();
    const bundle = await signUp(t, claims());
    // Redeems the sign-in token. Suppose the answer is lost, so the client keeps presenting the redeemed token.
    expectRotated(await refresh(t, bundle.refreshToken));
    await t.advanceTime(2 * HOUR_MS);

    const result = await t.mutation(api.public.refresh, {
      refreshToken: bundle.refreshToken,
      ...ttl({ refreshInactivityTimeoutSeconds: 60 * 60 }),
    });
    expect(result.kind).toBe("noSession");
    expect(await sessionCount(t)).toBe(0);
  });

  test("refuses a session past its max lifetime, however recently it refreshed", async () => {
    const t = setup();
    const lifetimes = ttl({ refreshInactivityTimeoutSeconds: 60 * 60, sessionMaxLifetimeSeconds: 2 * 60 * 60 });
    let bundle: TokenBundle = await t.mutation(api.public._internal_dangerous_signUp, {
      claims: claims(),
      componentPath: COMPONENT_PATH,
      createUserHandle: CREATE_USER_HANDLE,
      ...lifetimes,
    });
    // Refresh every half hour, well within the inactivity timeout, until the session is just short of its max lifetime.
    for (let i = 0; i < 3; i++) {
      await t.advanceTime(30 * 60 * 1000);
      bundle = expectRotated(await t.mutation(api.public.refresh, { refreshToken: bundle.refreshToken, ...lifetimes }));
    }
    // Just past the two-hour max lifetime. A `_creationTime` can run a fraction of a millisecond ahead of the clock (a
    // transaction starts no earlier than its snapshot), so the deadline is read from the session.
    const [session] = await t.run(async (ctx: any) => await ctx.db.query("sessions").collect());
    await t.advanceTime(Math.ceil(session._creationTime + 2 * HOUR_MS) - t.now() + 1);

    const result = await t.mutation(api.public.refresh, { refreshToken: bundle.refreshToken, ...lifetimes });
    expect(result.kind).toBe("noSession");
    expect(await sessionCount(t)).toBe(0);
  });

  test("a lowered max lifetime ends a session created before the change", async () => {
    const t = setup();
    // Created under the default 30-day max lifetime.
    const bundle = await signUp(t, claims());
    await t.advanceTime(2 * HOUR_MS);
    // Refresh under the old config, so that the lowered inactivity timeout cannot end the session.
    const fresh = expectRotated(await refresh(t, bundle.refreshToken));
    await t.advanceTime(60 * 1000);

    const result = await t.mutation(api.public.refresh, {
      refreshToken: fresh.refreshToken,
      ...ttl({ sessionMaxLifetimeSeconds: 60 * 60 }),
    });
    expect(result.kind).toBe("noSession");
    expect(await sessionCount(t)).toBe(0);
  });

  test("a redeemed token's inactivity counts from the session's newest token", async () => {
    const t = setup();
    const lifetimes = ttl({ refreshInactivityTimeoutSeconds: 60 * 60 });
    const bundle: TokenBundle = await t.mutation(api.public._internal_dangerous_signUp, {
      claims: claims(),
      componentPath: COMPONENT_PATH,
      createUserHandle: CREATE_USER_HANDLE,
      ...lifetimes,
    });
    // The refresh commits, but the client never gets the answer.
    await t.advanceTime(50 * 60 * 1000);
    expectRotated(await t.mutation(api.public.refresh, { refreshToken: bundle.refreshToken, ...lifetimes }));
    // The retried token is past the timeout, but the session last refreshed 20 minutes ago.
    await t.advanceTime(20 * 60 * 1000);

    expectRotated(await t.mutation(api.public.refresh, { refreshToken: bundle.refreshToken, ...lifetimes }));
    expect(await sessionCount(t)).toBe(1);
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
    await finishScheduledFunctions(t);
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
    await finishScheduledFunctions(t);
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
    await finishScheduledFunctions(t);
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
    await finishScheduledFunctions(t);
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
    // The tokens are erased in the background, right after the session.
    await finishScheduledFunctions(t);
    expect(await retiredHashes(t)).toEqual([]);
    expect(await issuedHashes(t)).toEqual([]);
  });

  test("a token whose session is gone reports no session", async () => {
    const t = setup();
    const bundle = await signUp(t, claims());
    const rotated = expectRotated(await refresh(t, bundle.refreshToken));
    const next = expectRotated(await refresh(t, rotated.refreshToken));

    await t.mutation(api.public.signOut, { refreshToken: next.refreshToken });

    // Before the tokens are erased, each still names the session, which ended already. A spent one is no sign of a
    // fork then: there is nothing left to revoke.
    expect(await issuedHashes(t)).toHaveLength(1);
    const { warnings } = await warningsOf(async () => {
      expect((await refresh(t, next.refreshToken)).kind).toBe("noSession");
      expect((await refresh(t, bundle.refreshToken)).kind).toBe("noSession");
    });
    expect(warnings).toEqual([]);
  });

  test("schedules the erasure of the session's refresh tokens", async () => {
    const t = setup();
    const bundle = await signUp(t, claims());
    await t.mutation(api.public.signOut, { refreshToken: bundle.refreshToken });

    // The session is gone at once; its token waits for `sessions:deleteSessionTokens`, then is gone too.
    expect(await sessionCount(t)).toBe(0);
    expect(await issuedHashes(t)).toHaveLength(1);
    const jobs = await t.run(async (ctx: any) => await ctx.db.system.query("_scheduled_functions").collect());
    expect(jobs).toHaveLength(1);
    expect(jobs[0].name).toMatch(/^sessions(\.js)?:deleteSessionTokens$/);
    await finishScheduledFunctions(t);
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
    const otherBundle = await signIn(t, claims(), bundle.userId);

    const sessions = await t.query(api.public.listSessions, { userId: bundle.userId });
    expect(sessions.map((s: { sessionId: string }) => s.sessionId).sort()).toEqual(
      [sessionIdOf(bundle), sessionIdOf(otherBundle)].sort(),
    );
  });

  test("lists the newest session first", async () => {
    const t = setup();
    const first = await signUp(t, claims());
    const second = await signIn(t, claims(), first.userId);
    const third = await signIn(t, claims(), first.userId);

    const sessions = await t.query(api.public.listSessions, { userId: first.userId });
    expect(sessions.map((s: { sessionId: string }) => s.sessionId)).toEqual([third, second, first].map(sessionIdOf));
  });

  test("lists only the sessions of the given user", async () => {
    const t = setup();
    const aliceBundle = await signUp(t, claims());
    await signUp(t, claims({ profile: { name: "Bob" } }));

    const sessions = await t.query(api.public.listSessions, { userId: aliceBundle.userId });
    expect(sessions.map((s: { sessionId: string }) => s.sessionId)).toEqual([sessionIdOf(aliceBundle)]);
  });

  test("reports when the session's newest refresh token was issued", async () => {
    const t = setup();
    const bundle = await signUp(t, claims());
    await t.advanceTime(60_000);
    const refreshedAt = t.now();
    const rotated = expectRotated(await refresh(t, bundle.refreshToken));

    const sessions = await t.query(api.public.listSessions, { userId: bundle.userId });
    expect(sessions).toEqual([
      { sessionId: sessionIdOf(rotated), creationTime: expect.any(Number), lastRefreshedAt: expect.any(Number) },
    ]);
    // A `_creationTime` is its transaction's start time, the next float up for each further insert (as Convex's
    // backend; convex-test's is `Date.now()`).
    expect(Math.floor(sessions[0].lastRefreshedAt)).toBe(refreshedAt);
  });

  test("includes a session whose refresh tokens have all expired", async () => {
    const t = setup();
    const stale = await signUp(t, claims());
    // Past the default 30-day inactivity timeout.
    await t.advanceTime(DAYS_31_MS);
    const fresh = await signIn(t, claims(), stale.userId);

    const sessions = await t.query(api.public.listSessions, { userId: stale.userId });
    expect(sessions.map((s: { sessionId: string }) => s.sessionId)).toEqual([fresh, stale].map(sessionIdOf));
  });

  test("no token outlives one inactivity timeout past the session's lastRefreshedAt", async () => {
    const t = setup();
    const oneHourSeconds = 60 * 60;
    const bundle = await signUp(t, claims());
    // Redeem the sign-in token, then present it again twice, as a client whose answers were lost would: the session
    // has two issued siblings.
    expectRotated(await refresh(t, bundle.refreshToken));
    await t.advanceTime(60_000);
    // Issued under the default 30-day inactivity timeout.
    const older = expectRotated(await refresh(t, bundle.refreshToken));
    await t.advanceTime(60_000);
    // Issued after the timeout was lowered to an hour.
    expectRotated(
      await t.mutation(api.public.refresh, {
        refreshToken: bundle.refreshToken,
        ...ttl({ refreshInactivityTimeoutSeconds: oneHourSeconds }),
      }),
    );

    const [listed] = await t.query(api.public.listSessions, { userId: bundle.userId });
    expect(Math.floor(listed.lastRefreshedAt)).toBe(t.now());

    // Once past it, the older sibling, issued under the longer timeout, cannot refresh the session either.
    await t.advanceTime(Math.ceil(listed.lastRefreshedAt + oneHourSeconds * 1000) - t.now());
    const result = await t.mutation(api.public.refresh, {
      refreshToken: older.refreshToken,
      ...ttl({ refreshInactivityTimeoutSeconds: oneHourSeconds }),
    });
    expect(result.kind).toBe("noSession");
  });

  test("leaves out, with a warning, a session with no issued token", async () => {
    const t = setup();
    const bundle = await signUp(t, claims());
    const otherBundle = await signIn(t, claims(), bundle.userId);
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

describe(`the cap of ${MAX_SESSIONS_PER_USER} sessions per user`, () => {
  /** Sign the user in until they have `count` sessions, a second apart. */
  async function signInUntil(t: TestBunvex, count: number): Promise<TokenBundle[]> {
    const bundles = [await signUp(t, claims())];
    while (bundles.length < count) {
      await t.advanceTime(1000);
      bundles.push(await signIn(t, claims(), bundles[0]!.userId));
    }
    return bundles;
  }

  test("keeps every session up to the cap", async () => {
    const t = setup();
    const { warnings } = await warningsOf(() => signInUntil(t, MAX_SESSIONS_PER_USER));
    expect(await sessionCount(t)).toBe(MAX_SESSIONS_PER_USER);
    expect(warnings.filter((w) => w.includes("Evicted"))).toEqual([]);
  });

  test("a sign-in at the cap revokes the session that refreshed longest ago", async () => {
    const t = setup();
    const [first, second, third] = (await signInUntil(t, MAX_SESSIONS_PER_USER)) as [
      TokenBundle,
      TokenBundle,
      TokenBundle,
    ];
    // The oldest session is still in use, so the next oldest goes instead.
    await t.advanceTime(1000);
    expectRotated(await refresh(t, first.refreshToken));

    await t.advanceTime(1000);
    const { result: newest, warnings } = await warningsOf(() => signIn(t, claims(), first.userId));

    expect(warnings).toContain(`Evicted 1 session past the ${MAX_SESSIONS_PER_USER} session limit for a single user`);
    expect(await sessionCount(t)).toBe(MAX_SESSIONS_PER_USER);
    const listed = (await t.query(api.public.listSessions, { userId: first.userId })).map(
      (s: { sessionId: string }) => s.sessionId,
    );
    expect(listed).not.toContain(sessionIdOf(second));
    expect(listed).toContain(sessionIdOf(first));
    expect(listed).toContain(sessionIdOf(third));
    expect(listed).toContain(sessionIdOf(newest));
    expect((await refresh(t, second.refreshToken)).kind).toBe("noSession");
  });

  test("erases the revoked session's refresh tokens", async () => {
    const t = setup();
    const [first] = (await signInUntil(t, MAX_SESSIONS_PER_USER)) as [TokenBundle];
    await signIn(t, claims(), first.userId);
    await finishScheduledFunctions(t);
    const remaining = await t.run(
      async (ctx: any) =>
        await ctx.db
          .query("refreshTokens")
          .withIndex("by_session_state", (q: any) => q.eq("sessionId", sessionIdOf(first) as Id<"sessions">))
          .collect(),
    );
    expect(remaining).toEqual([]);
  });

  test("a user over the cap is brought back to it", async () => {
    const t = setup();
    const bundles = await signInUntil(t, MAX_SESSIONS_PER_USER);
    // Sessions from before the cap existed; not reachable by signing in.
    await t.run(async (ctx: any) => {
      const { component } = await ctx.db.get(sessionIdOf(bundles[0]!) as Id<"sessions">);
      for (let i = 0; i < 2; i++) {
        const sessionId = await ctx.db.insert("sessions", { userId: bundles[0]!.userId, component });
        await ctx.db.insert("refreshTokens", { hash: `extra-${i}`, sessionId, state: "issued" });
      }
    });

    await t.advanceTime(1000);
    const { result: newest, warnings } = await warningsOf(() => signIn(t, claims(), bundles[0]!.userId));

    expect(warnings).toContain(`Evicted 3 sessions past the ${MAX_SESSIONS_PER_USER} session limit for a single user`);
    expect(await sessionCount(t)).toBe(MAX_SESSIONS_PER_USER);
    const listed = (await t.query(api.public.listSessions, { userId: newest.userId })).map(
      (s: { sessionId: string }) => s.sessionId,
    );
    expect(listed).not.toContain(sessionIdOf(bundles[0]!));
    expect(listed).not.toContain(sessionIdOf(bundles[1]!));
    expect(listed).not.toContain(sessionIdOf(bundles[2]!));
    expect(listed).toContain(sessionIdOf(newest));
  });

  test("counts only the user's own sessions", async () => {
    const t = setup();
    const bob = await signUp(t, claims({ profile: { name: "Bob" } }));
    const [first] = (await signInUntil(t, MAX_SESSIONS_PER_USER)) as [TokenBundle];
    await signIn(t, claims(), first.userId);

    expect(await t.query(api.public.listSessions, { userId: bob.userId })).toHaveLength(1);
    expect(await t.query(api.public.listSessions, { userId: first.userId })).toHaveLength(MAX_SESSIONS_PER_USER);
  });
});

describe("revokeSessions", () => {
  test("revokes the sessions so they can no longer be refreshed", async () => {
    const t = setup();
    const bundle = await signUp(t, claims());
    const second = await signIn(t, claims(), bundle.userId);
    const third = await signIn(t, claims(), bundle.userId);

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
    const bob = await signUp(t, claims({ profile: { name: "Bob" } }));

    const revoked = await t.mutation(api.public.revokeSessions, { sessionIds: [sessionIdOf(alice), sessionIdOf(bob)] });
    expect(revoked).toHaveLength(2);
    expect(await sessionCount(t)).toBe(0);
  });

  test("erases the sessions' refresh tokens", async () => {
    const t = setup();
    const bundle = await signUp(t, claims());
    expectRotated(await refresh(t, bundle.refreshToken));

    await t.mutation(api.public.revokeSessions, { sessionIds: [sessionIdOf(bundle)] });
    await finishScheduledFunctions(t);
    expect(await t.run(async (ctx: any) => await ctx.db.query("refreshTokens").collect())).toEqual([]);
  });

  test("revokes sessions holding more refresh tokens than one transaction can delete", async () => {
    // The transaction limits are always the real ones: 16,000 writes and 32,000 reads. The deployment's write
    // throughput limit (4 MiB a second, which convex-test does not have) would hold the scheduled erasures back on the
    // virtual clock: it is raised for this deployment, whose engine reads it as it starts.
    const saved = process.env.MAX_BYTES_WRITTEN_PER_SECOND;
    process.env.MAX_BYTES_WRITTEN_PER_SECOND = String(1024 * 1024 * 1024);
    const t = setup();
    let bundles: TokenBundle[];
    try {
      bundles = [await signUp(t, claims())];
    } finally {
      if (saved === undefined) delete process.env.MAX_BYTES_WRITTEN_PER_SECOND;
      else process.env.MAX_BYTES_WRITTEN_PER_SECOND = saved;
    }
    for (let i = 1; i < 12; i++) bundles.push(await signIn(t, claims(), bundles[0]!.userId));
    // 1,500 rows each, 18,000 in all: more than one transaction may delete, and more than one run of the erasure takes
    // for a single session.
    for (const bundle of bundles)
      await t.run(async (ctx: any) => {
        for (let i = 1; i < 1500; i++)
          await ctx.db.insert("refreshTokens", {
            hash: `${sessionIdOf(bundle)}-${i}`,
            sessionId: sessionIdOf(bundle) as Id<"sessions">,
            state: "spent",
            retiredAt: Date.now(),
          });
      });

    const revoked = await t.mutation(api.public.revokeSessions, { sessionIds: bundles.map(sessionIdOf) });
    expect(revoked).toHaveLength(12);
    expect(await sessionCount(t)).toBe(0);
    await finishScheduledFunctions(t);
    expect(await t.run(async (ctx: any) => (await ctx.db.query("refreshTokens").collect()).length)).toBe(0);
  });

  test("skips an already-revoked session id", async () => {
    const t = setup();
    const bundle = await signUp(t, claims());
    const otherBundle = await signIn(t, claims(), bundle.userId);
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
  const signUpWith = (t: TestBunvex, lifetimes: Record<string, number>): Promise<TokenBundle> =>
    t.mutation(api.public._internal_dangerous_signUp, {
      claims: claims(),
      componentPath: COMPONENT_PATH,
      createUserHandle: CREATE_USER_HANDLE,
      ...lifetimes,
    });

  test("honors a custom access-token TTL on sign-up", async () => {
    const t = setup();
    const before = t.now();
    const bundle = await signUpWith(t, ttl({ accessTokenTtlSeconds: 300 }));
    // The JWT `exp` is floored to the second, so allow a small window.
    const expMs = decodeJwt(bundle.accessToken).exp! * 1000;
    expect(expMs).toBeGreaterThanOrEqual(before + 300_000 - 1000);
    expect(expMs).toBeLessThanOrEqual(t.now() + 300_000);
  });

  test("honors a custom inactivity timeout on sign-up and on rotation", async () => {
    const t = setup();
    const oneHourSeconds = 60 * 60;
    const oneHourMs = oneHourSeconds * 1000;

    const before = t.now();
    const bundle = await signUpWith(t, ttl({ refreshInactivityTimeoutSeconds: oneHourSeconds }));
    expect(bundle.refreshTokenExpiresAt).toBeGreaterThanOrEqual(before + oneHourMs);
    // A transaction's time is its start, floored at its snapshot (as Convex's), so it may be a millisecond past the clock's.
    expect(bundle.refreshTokenExpiresAt).toBeLessThanOrEqual(t.now() + oneHourMs + 1000);

    // The rotated token gets the configured timeout too.
    const rotated = expectRotated(
      await t.mutation(api.public.refresh, {
        refreshToken: bundle.refreshToken,
        ...ttl({ refreshInactivityTimeoutSeconds: oneHourSeconds }),
      }),
    );
    expect(rotated.refreshTokenExpiresAt).toBeLessThanOrEqual(t.now() + oneHourMs + 1000);
  });

  test("caps the refresh token's expiry at the session's max lifetime", async () => {
    const t = setup();
    const lifetimes = ttl({ refreshInactivityTimeoutSeconds: 2 * 60 * 60, sessionMaxLifetimeSeconds: 3 * 60 * 60 });
    const bundle = await signUpWith(t, lifetimes);
    const [session] = await t.run(async (ctx: any) => await ctx.db.query("sessions").collect());
    // Fresh, the inactivity timeout comes first.
    expect(bundle.refreshTokenExpiresAt).toBeGreaterThanOrEqual(t.now() + 2 * HOUR_MS);
    expect(bundle.refreshTokenExpiresAt).toBeLessThan(session._creationTime + 3 * HOUR_MS);

    // Two hours in, the max lifetime comes first.
    await t.advanceTime(2 * HOUR_MS - 60_000);
    const rotated = expectRotated(
      await t.mutation(api.public.refresh, { refreshToken: bundle.refreshToken, ...lifetimes }),
    );
    expect(rotated.refreshTokenExpiresAt).toBe(session._creationTime + 3 * HOUR_MS);
  });

  test("rejects a configuration where the access TTL is not shorter than the inactivity timeout", async () => {
    const t = setup();
    await expect(
      signUpWith(t, { ...DEFAULT_TTL, accessTokenTtlSeconds: 100, refreshInactivityTimeoutSeconds: 1 }),
    ).rejects.toThrow("Access-token TTL must be shorter than the refresh inactivity timeout.");
  });

  test("rejects a configuration where the inactivity timeout is longer than the max lifetime", async () => {
    const t = setup();
    await expect(
      signUpWith(t, {
        ...DEFAULT_TTL,
        refreshInactivityTimeoutSeconds: 2 * 60 * 60,
        sessionMaxLifetimeSeconds: 60 * 60,
      }),
    ).rejects.toThrow("Refresh inactivity timeout must be at most the session max lifetime.");
  });

  test("accepts an inactivity timeout equal to the max lifetime", async () => {
    const t = setup();
    const bundle = await signUpWith(
      t,
      ttl({ refreshInactivityTimeoutSeconds: 60 * 60, sessionMaxLifetimeSeconds: 60 * 60 }),
    );
    const [session] = await t.run(async (ctx: any) => await ctx.db.query("sessions").collect());
    expect(bundle.refreshTokenExpiresAt).toBeLessThanOrEqual(session._creationTime + HOUR_MS);
  });

  test("rejects a non-finite or non-positive lifetime and an access TTL over an hour, in every function", async () => {
    const t = setup();
    await expect(signUpWith(t, { ...DEFAULT_TTL, sessionMaxLifetimeSeconds: Number.NaN })).rejects.toThrow(
      "Token and session lifetimes must be finite numbers.",
    );
    await expect(signUpWith(t, { ...DEFAULT_TTL, accessTokenTtlSeconds: 0 })).rejects.toThrow(
      "Token and session lifetimes must be positive.",
    );
    await expect(signUpWith(t, { ...DEFAULT_TTL, accessTokenTtlSeconds: 3601 })).rejects.toThrow(
      "Access-token TTL must be at most one hour (the deployment refuses to sign a longer-lived JWT).",
    );
    const bundle = await signUp(t, claims());
    await expect(
      t.mutation(api.public._internal_dangerous_signIn, {
        claims: claims(),
        componentPath: COMPONENT_PATH,
        userId: bundle.userId,
        ...DEFAULT_TTL,
        accessTokenTtlSeconds: -1,
      }),
    ).rejects.toThrow("Token and session lifetimes must be positive.");
    await expect(
      t.mutation(api.public.refresh, { refreshToken: bundle.refreshToken, ...DEFAULT_TTL, accessTokenTtlSeconds: 0 }),
    ).rejects.toThrow("Token and session lifetimes must be positive.");
    // The component has no defaults of its own: a call must pass all three.
    await expect(t.mutation(api.public.refresh, { refreshToken: bundle.refreshToken })).rejects.toThrow();
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
    const tokenId = await t.run(async (ctx: any) => (await ctx.db.query("refreshTokens").unique())!._id);
    expect(await t.query(api.public.getSession, { sessionId: tokenId })).toBeNull();
  });
});
