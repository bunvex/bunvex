// The password component's suite (STUDY-201 §3.4), upstream's `components/password/passwordProvider.test.ts` ported.
// The component is mounted as a component named `authPassword` (fixtures/password-component, the real functions plus
// `testing`'s row access), since the runtime's hasher answers only that component's mutations (AD-49); upstream runs it
// as the root app. Upstream's interoperability tests call its WASM crate in the test's process; here the hashes are the
// component's own, set and checked through its mutations, and `hash-wasm` checks them the other way.
// biome-ignore-all lint/suspicious/noExplicitAny: the component's references are untyped
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { componentsGeneric } from "@bunvex/server";
import { bunvexTest, type TestBunvex } from "@bunvex/testing";
import { argon2d, argon2i, argon2id, argon2Verify, bcrypt, bcryptVerify } from "hash-wasm";

const COMPONENT = join(import.meta.dir, "fixtures", "password-component");
const PASSWORD = "correct horse battery staple"; // 28 chars, valid
const authPassword = (componentsGeneric() as any).authPassword;
const api = authPassword.public;

const open: TestBunvex[] = [];
afterEach(async () => {
  for (const t of open.splice(0)) await t.close();
});
// Each test pushes a deployment of its own; under a full `bun run check` a push can take past the default 5 s.
setDefaultTimeout(60_000);

function setup(): TestBunvex {
  const t = bunvexTest();
  open.push(t);
  // Its child, the rate limiter that throttles `verifyPassword`, comes with its definition.
  t.registerComponent("authPassword", COMPONENT);
  return t;
}

const setPassword = (t: TestBunvex, password: string, userId = "alice") =>
  t.mutation(api.setPassword, { userId, password });
const verifyPassword = (t: TestBunvex, password: string, userId = "alice") =>
  t.mutation(api.verifyPassword, { userId, password });
const storedHash = async (t: TestBunvex) =>
  ((await t.query(authPassword.testing.passwords, {})) as { passwordHashPHC: string }[])[0]!.passwordHashPHC;
const storeHash = (t: TestBunvex, passwordHashPHC: string, userId = "alice") =>
  t.mutation(authPassword.testing.insertHash, { userId, passwordHashPHC });

// The parameters of the component's hashes (argon2id, 16 MiB, 3 passes, 1 lane, a 32-byte tag).
const ARGON2_PARAMS = { iterations: 3, parallelism: 1, memorySize: 16 * 1024, hashLength: 32 };
const salt = () => crypto.getRandomValues(new Uint8Array(16));

describe("setPassword + verifyPassword", () => {
  test("verifies the correct password after setting it", async () => {
    const t = setup();
    expect(await setPassword(t, PASSWORD)).toEqual({ success: true });
    expect(await verifyPassword(t, PASSWORD)).toEqual({ success: true });
  });

  test("rejects a wrong password", async () => {
    const t = setup();
    await setPassword(t, PASSWORD);
    expect(await verifyPassword(t, "wrong horse battery staple")).toEqual({
      success: false,
      userError: { error: "INVALID_CREDENTIALS" },
    });
  });

  test("throws for an unknown user id", async () => {
    const t = setup();
    await expect(verifyPassword(t, PASSWORD, "nobody")).rejects.toThrow("No password stored for userId nobody.");
  });

  test("upserts: setting a new password replaces the old one", async () => {
    const t = setup();
    await setPassword(t, PASSWORD);
    const newPassword = "a whole new password here";
    await setPassword(t, newPassword);

    // Only one row exists for the user.
    expect(await t.query(authPassword.testing.passwords, {})).toHaveLength(1);
    expect(await verifyPassword(t, newPassword)).toEqual({ success: true });
    expect(await verifyPassword(t, PASSWORD)).toEqual({
      success: false,
      userError: { error: "INVALID_CREDENTIALS" },
    });
  });

  test("stores v2's PHC string: argon2id, 16 MiB, 3 passes, 1 lane, a 16-byte salt, a 32-byte tag", async () => {
    const t = setup();
    await setPassword(t, PASSWORD);
    expect(await storedHash(t)).toMatch(/^\$argon2id\$v=19\$m=16384,t=3,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/);
  });
});

describe("password validation (setPassword)", () => {
  test("rejects a too-short password", async () => {
    const t = setup();
    expect(await setPassword(t, "short")).toEqual({
      success: false,
      userError: { error: "PASSWORD_TOO_SHORT", minimumLength: 10 },
    });
  });

  test("rejects a password with leading whitespace", async () => {
    const t = setup();
    expect(await setPassword(t, " leadingspace123")).toEqual({
      success: false,
      userError: { error: "PASSWORD_HAS_SURROUNDING_WHITESPACE" },
    });
  });

  test("rejects one of the most frequent passwords", async () => {
    const t = setup();
    expect(await setPassword(t, "password123")).toEqual({
      success: false,
      userError: { error: "PASSWORD_TOO_COMMON" },
    });
  });

  test("rejects a frequent password that has a different case", async () => {
    const t = setup();
    expect(await setPassword(t, "Password123")).toEqual({
      success: false,
      userError: { error: "PASSWORD_TOO_COMMON" },
    });
  });
});

describe("password validation (verifyPassword)", () => {
  test("rejects a too-short password without touching the stored password", async () => {
    const t = setup();
    await setPassword(t, PASSWORD);
    expect(await verifyPassword(t, "short")).toEqual({
      success: false,
      userError: { error: "PASSWORD_TOO_SHORT", minimumLength: 10 },
    });
  });

  test("rejects a too-long password", async () => {
    const t = setup();
    await setPassword(t, PASSWORD);
    expect(await verifyPassword(t, "a".repeat(101))).toEqual({
      success: false,
      userError: { error: "PASSWORD_TOO_LONG", maximumLength: 100 },
    });
  });

  test("rejects a password with surrounding whitespace", async () => {
    const t = setup();
    await setPassword(t, PASSWORD);
    expect(await verifyPassword(t, " leadingspace123")).toEqual({
      success: false,
      userError: { error: "PASSWORD_HAS_SURROUNDING_WHITESPACE" },
    });
  });

  // A user may have a frequent password from before the rule, and must still sign in: only `setPassword` refuses one.
  test("accepts one of the most frequent passwords", async () => {
    const t = setup();
    const commonPassword = "password123";
    await storeHash(
      t,
      await argon2id({ ...ARGON2_PARAMS, password: commonPassword, salt: salt(), outputType: "encoded" }),
    );
    expect(await verifyPassword(t, commonPassword)).toEqual({ success: true });
  });
});

describe("Unicode normalization", () => {
  test("verifies across differing normalization forms", async () => {
    const t = setup();
    // "café…" spelled two ways: composed é (U+00E9) and decomposed e + combining acute (U+0301), padded to the length.
    const composed = "café password test";
    const decomposed = "café password test";
    expect(composed).not.toBe(decomposed);
    expect(composed.normalize("NFC")).toBe(decomposed.normalize("NFC"));

    await setPassword(t, composed);
    expect(await verifyPassword(t, decomposed)).toEqual({ success: true });
  });
});

describe("interoperability with hash-wasm", () => {
  test("hash-wasm can verify a hash the component made", async () => {
    const t = setup();
    await setPassword(t, PASSWORD);
    expect(await argon2Verify({ password: PASSWORD, hash: await storedHash(t) })).toBe(true);
  });

  test("hash-wasm rejects the wrong password against the component's hash", async () => {
    const t = setup();
    await setPassword(t, PASSWORD);
    expect(await argon2Verify({ password: "wrong password entirely", hash: await storedHash(t) })).toBe(false);
  });

  test("the component can verify a hash produced by hash-wasm", async () => {
    const t = setup();
    await storeHash(t, await argon2id({ ...ARGON2_PARAMS, password: PASSWORD, salt: salt(), outputType: "encoded" }));
    expect(await verifyPassword(t, PASSWORD)).toEqual({ success: true });
  });

  test("the component rejects the wrong password against hash-wasm's hash", async () => {
    const t = setup();
    await storeHash(t, await argon2id({ ...ARGON2_PARAMS, password: PASSWORD, salt: salt(), outputType: "encoded" }));
    expect(await verifyPassword(t, "wrong password entirely")).toEqual({
      success: false,
      userError: { error: "INVALID_CREDENTIALS" },
    });
  });
});

// Verification re-derives the algorithm, version and parameters from the stored string, and refuses only one that is
// not argon2i, argon2d or argon2id.
describe("verifyPassword is lenient about the stored PHC string", () => {
  test("verifies an argon2i PHC hash", async () => {
    const t = setup();
    const phc = await argon2i({ ...ARGON2_PARAMS, password: PASSWORD, salt: salt(), outputType: "encoded" });
    expect(phc.startsWith("$argon2i$")).toBe(true);
    await storeHash(t, phc);
    expect(await verifyPassword(t, PASSWORD)).toEqual({ success: true });
  });

  test("verifies an argon2d PHC hash", async () => {
    const t = setup();
    const phc = await argon2d({ ...ARGON2_PARAMS, password: PASSWORD, salt: salt(), outputType: "encoded" });
    expect(phc.startsWith("$argon2d$")).toBe(true);
    await storeHash(t, phc);
    expect(await verifyPassword(t, PASSWORD)).toEqual({ success: true });
  });

  test("verifies an argon2id PHC hash with different parameters than ours", async () => {
    const t = setup();
    await storeHash(
      t,
      await argon2id({
        password: PASSWORD,
        salt: salt(),
        iterations: 2, // the component's are 3
        parallelism: 1,
        memorySize: 8 * 1024, // the component's are 16 * 1024
        hashLength: 16, // the component's are 32
        outputType: "encoded",
      }),
    );
    expect(await verifyPassword(t, PASSWORD)).toEqual({ success: true });
  });

  test("does not verify a PHC-style hash using a non-argon2 algorithm", async () => {
    const t = setup();
    const phc = await bcrypt({ password: PASSWORD, salt: salt(), costFactor: 4, outputType: "encoded" });
    expect(phc.startsWith("$2a$")).toBe(true);
    // Sanity check: hash-wasm itself can verify its own bcrypt hash.
    expect(await bcryptVerify({ password: PASSWORD, hash: phc })).toBe(true);
    // Only the argon2 family is understood: bcrypt's string is refused outright, not `false`, nor read as argon2id.
    await storeHash(t, phc);
    await expect(verifyPassword(t, PASSWORD)).rejects.toThrow("Failed to verify password against the stored hash");
  });
});

describe("rate limiting (verifyPassword only)", () => {
  test("returns RATE_LIMITED once the per-user bucket is exhausted", async () => {
    const t = setup();
    await setPassword(t, PASSWORD);

    // Capacity is 5: the first five attempts (a wrong password) go through, the sixth in the same window is refused.
    for (let i = 0; i < 5; i++) await verifyPassword(t, "wrong horse battery staple");
    const result = await verifyPassword(t, PASSWORD);
    expect(result.success).toBe(false);
    expect(result.userError.error).toBe("RATE_LIMITED");
    expect(typeof result.userError.retryAfterMs).toBe("number");
  });

  test("the bucket is per user, and refills one attempt a minute", async () => {
    const t = setup();
    await setPassword(t, PASSWORD, "alice");
    await setPassword(t, PASSWORD, "bob");
    for (let i = 0; i < 5; i++) await verifyPassword(t, "wrong horse battery staple", "alice");
    const limited = await verifyPassword(t, PASSWORD, "alice");
    expect(limited.userError.error).toBe("RATE_LIMITED");
    // About a minute, from the transaction's time (which may be a millisecond past the clock's).
    expect(limited.userError.retryAfterMs).toBeGreaterThan(59_000);
    expect(limited.userError.retryAfterMs).toBeLessThanOrEqual(60_001);
    expect(await verifyPassword(t, PASSWORD, "bob")).toEqual({ success: true });
    await t.advanceTime(Math.ceil(limited.userError.retryAfterMs) + 1);
    expect(await verifyPassword(t, PASSWORD, "alice")).toEqual({ success: true });
  });
});
