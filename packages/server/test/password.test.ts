// The password hasher (AD-49, STUDY-201 C-2) against Convex Auth v2.0.0's `password-hash-wasm` (a test dependency
// only): the same salt gives the same PHC string byte for byte, each verifies the other's, and a stored string is read
// as v2 reads it (STUDY-208 §6): one that is not a PHC string throws v2's message, and one that argon2 cannot verify
// does not match.
import { beforeAll, describe, expect, test } from "bun:test";
import { argon2 } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { argon2idPhc, MAX_MEMORY_KIB, MAX_PASSES, verifyPhc } from "../src/password.ts";

type Wasm = {
  default: (init: { module_or_path: Uint8Array }) => Promise<unknown>;
  hash_password: (password: string, salt: Uint8Array) => string;
  verify_password: (password: string, hash: string) => boolean;
};
let wasm: Wasm;
beforeAll(async () => {
  // Its package exports only `dist`, which imports the `.wasm` through a bundler plugin: load the module directly.
  const root = dirname(createRequire(import.meta.url).resolve("password-hash-wasm/package.json"));
  const pkg = join(root, "rust", "pkg", "argon2id");
  wasm = (await import(join(pkg, "argon2id.js"))) as Wasm;
  await wasm.default({ module_or_path: readFileSync(join(pkg, "argon2id_bg.wasm")) });
});

/** v2's `verifyPassword`: the crate's answer, its error wrapped as `password-hash-wasm/src/argon2id.ts` wraps it. */
function theirs(password: string, hash: string): boolean | string {
  try {
    return wasm.verify_password(password, hash);
  } catch (cause) {
    return `Failed to verify password against the stored hash: ${cause}`;
  }
}
async function ours(password: string, hash: string): Promise<boolean | string> {
  try {
    return await verifyPhc(password, hash);
  } catch (e) {
    return (e as Error).message;
  }
}

const saltOf = (seed: number) => new Uint8Array(16).map((_, i) => (i * 37 + seed) & 0xff);
const PASSWORDS = ["correct horse battery staple", "", "pässwörd 🔐 ñ", "a".repeat(200)];
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64").replace(/=+$/, "");

describe("the same as password-hash-wasm", () => {
  test.each(PASSWORDS.map((p, i) => [p, i] as const))("hash of %p: the same string", async (password, i) => {
    const salt = saltOf(i);
    const ours = await argon2idPhc(password, salt);
    expect(ours).toBe(wasm.hash_password(password, salt));
    expect(ours).toMatch(/^\$argon2id\$v=19\$m=16384,t=3,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/);
  });

  test("each verifies the other's hash; a wrong password does not", async () => {
    const theirs = wasm.hash_password("hunter2hunter2", saltOf(9));
    const ours = await argon2idPhc("hunter2hunter2", saltOf(10));
    expect(await verifyPhc("hunter2hunter2", theirs)).toBe(true);
    expect(wasm.verify_password("hunter2hunter2", ours)).toBe(true);
    expect(await verifyPhc("hunter2hunter3", theirs)).toBe(false);
    expect(wasm.verify_password("hunter2hunter3", ours)).toBe(false);
  });
});

describe("a stored string, read as v2 reads it", () => {
  const PW = "pw-12345678";
  const salt = saltOf(3);
  const derive = (
    algorithm: "argon2i" | "argon2d" | "argon2id",
    memory: number,
    passes: number,
    tagLength = 32,
    associatedData?: Uint8Array,
  ) =>
    new Promise<Buffer>((resolve, reject) =>
      argon2(
        algorithm,
        {
          message: PW,
          nonce: salt,
          memory,
          passes,
          parallelism: 1,
          tagLength,
          ...(associatedData ? { associatedData } : {}),
        },
        (e, t) => (e ? reject(e) : resolve(t)),
      ),
    );
  const phc = (...fields: string[]) => `$${fields.join("$")}`;
  const S = b64(salt);
  let cases: [string, string, boolean | "throws"][];

  beforeAll(async () => {
    const T = b64(await derive("argon2id", 1024, 2));
    const atDefaults = b64(await derive("argon2id", 19456, 2));
    const data = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const withData = b64(await derive("argon2id", 1024, 2, 32, data));
    const M = "m=1024,t=2,p=1";
    cases = [
      // What verifies: the string's own algorithm, costs and tag length; what is missing takes argon2 0.5's defaults.
      ["argon2id", phc("argon2id", "v=19", M, S, T), true],
      ["argon2i", phc("argon2i", "v=19", M, S, b64(await derive("argon2i", 1024, 2, 24))), true],
      ["argon2d", phc("argon2d", "v=19", M, S, b64(await derive("argon2d", 1024, 2, 48))), true],
      ["no version (0x13)", phc("argon2id", M, S, T), true],
      ["the costs in another order", phc("argon2id", "v=19", "t=2,m=1024,p=1", S, T), true],
      ["a cost given twice: the last one", phc("argon2id", "v=19", "m=8,m=1024,t=2,p=1", S, T), true],
      ["no p (1)", phc("argon2id", "v=19", "m=1024,t=2", S, T), true],
      ["no parameters (m=19456, t=2, p=1)", phc("argon2id", "v=19", S, atDefaults), true],
      ["a keyid, unused", phc("argon2id", "v=19", `${M},keyid=AAAA`, S, T), true],
      ["data: the associated data", phc("argon2id", "v=19", `${M},data=${b64(data)}`, S, withData), true],
      ["data missing", phc("argon2id", "v=19", M, S, withData), false],
      // A PHC string argon2 cannot verify does not match.
      ["scrypt", phc("scrypt", "ln=14,r=8,p=1", S, T), false],
      ["scrypt, argon2's parameters", phc("scrypt", "v=19", M, S, T), false],
      ["pbkdf2", phc("pbkdf2-sha256", "i=1000", S, T), false],
      ["an unknown id, no parameters", phc("foo", S, T), false],
      ["version 0x10 (DV-585)", phc("argon2id", "v=16", M, S, T), false],
      ["version 20", phc("argon2id", "v=20", M, S, T), false],
      ["a version among the parameters", phc("argon2id", `v=19,${M}`, S, T), false],
      ["an unknown parameter", phc("argon2id", "v=19", `${M},x=1`, S, T), false],
      ["a cost with a leading zero", phc("argon2id", "v=19", "m=01024,t=2,p=1", S, T), false],
      ["a cost that is not a number", phc("argon2id", "v=19", "m=abc,t=2,p=1", S, T), false],
      ["a cost over 2^32 - 1", phc("argon2id", "v=19", "m=4294967296,t=2,p=1", S, T), false],
      ["m under 8", phc("argon2id", "v=19", "m=4,t=2,p=1", S, T), false],
      ["m under 8 p", phc("argon2id", "v=19", "m=16,t=2,p=4", S, T), false],
      ["t=0", phc("argon2id", "v=19", "m=1024,t=0,p=1", S, T), false],
      ["p=0", phc("argon2id", "v=19", "m=1024,t=2,p=0", S, T), false],
      ["a keyid over 8 bytes", phc("argon2id", "v=19", `${M},keyid=${b64(new Uint8Array(9))}`, S, T), false],
      ["data over 32 bytes", phc("argon2id", "v=19", `${M},data=${b64(new Uint8Array(33))}`, S, T), false],
      ["a salt under 8 bytes", phc("argon2id", "v=19", M, "abcd", T), false],
      ["a salt that is not base64", phc("argon2id", "v=19", M, `${S.slice(0, -1)}.`, T), false],
      ["no tag", phc("argon2id", "v=19", M, S), false],
      ["no salt and no tag", phc("argon2id", "v=19", M), false],
      ["a 10-byte tag", phc("argon2id", "v=19", M, S, b64(new Uint8Array(10))), false],
      ["a 64-byte tag", phc("argon2id", "v=19", M, S, b64(new Uint8Array(64))), false],
      // What is not a PHC string throws.
      ["empty", "", "throws"],
      ["plain text", "plaintext", "throws"],
      ["only $", "$", "throws"],
      ["an uppercase id", phc("Argon2id", "v=19", M, S, T), "throws"],
      ["an id over 32 characters", phc("a".repeat(33), S, T), "throws"],
      ["a version that is not a number", phc("argon2id", "v=abc", M, S, T), "throws"],
      ["an empty version", phc("argon2id", "v=", M, S, T), "throws"],
      ["a parameter name with an uppercase letter", phc("argon2id", "v=19", "M=1024", S, T), "throws"],
      ["an empty parameter", phc("argon2id", "v=19", "m=1024,,t=2", S, T), "throws"],
      ["a parameter with two =", phc("argon2id", "v=19", "m=1=2", S, T), "throws"],
      ["a parameter value over 64 bytes", phc("argon2id", "v=19", `m=${"1".repeat(65)}`, S, T), "throws"],
      ["a parameter value with *", phc("argon2id", "v=19", "m=1*", S, T), "throws"],
      ["parameters over 127 bytes", phc("argon2id", "v=19", `${M},data=${"A".repeat(120)}`, S, T), "throws"],
      ["an empty salt", phc("argon2id", "v=19", M, "", T), "throws"],
      ["a salt under 4 characters", phc("argon2id", "v=19", M, "abc", T), "throws"],
      ["a salt over 64 characters", phc("argon2id", "v=19", M, "a".repeat(65), T), "throws"],
      ["a salt with *", phc("argon2id", "v=19", M, "c2Fs*", T), "throws"],
      ["an empty tag", phc("argon2id", "v=19", M, S, ""), "throws"],
      ["a 9-byte tag", phc("argon2id", "v=19", M, S, b64(new Uint8Array(9))), "throws"],
      ["a 65-byte tag", phc("argon2id", "v=19", M, S, b64(new Uint8Array(65))), "throws"],
      ["a padded tag", phc("argon2id", "v=19", M, S, `${T}=`), "throws"],
      ["a tag with *", phc("argon2id", "v=19", M, S, `${T.slice(0, -1)}*`), "throws"],
      ["a tag whose length is 1 past a multiple of 4", phc("argon2id", "v=19", M, S, `${T}AA`), "throws"],
      ["a tag one byte longer", phc("argon2id", "v=19", M, S, `${T}A`), false],
      ["a tag with nonzero trailing bits", phc("argon2id", "v=19", M, S, `${T.slice(0, -1)}B`), "throws"],
      ["a field after the tag", `${phc("argon2id", "v=19", M, S, T)}$`, "throws"],
    ];
  });

  test("each case: v2's answer, or v2's error message", async () => {
    for (const [name, hash, expected] of cases) {
      const v2 = theirs(PW, hash);
      expect([name, typeof v2 === "string" ? "throws" : v2]).toEqual([name, expected]);
      expect([name, await ours(PW, hash)]).toEqual([name, v2]);
    }
  });

  test("a wrong password never matches what verifies", async () => {
    for (const [name, hash, expected] of cases) {
      if (expected !== true) continue;
      expect([name, await ours("pw-87654321", hash)]).toEqual([name, false]);
    }
  });

  // Bounded (the owner, 2026-11-02): computed in the deployment's process, not in a function's bounded isolate.
  test("costs up to 64 MiB and 10 passes verify; over them, the stored hash is refused before any work", async () => {
    const atMemory = phc(
      "argon2id",
      "v=19",
      `m=${MAX_MEMORY_KIB},t=1,p=1`,
      S,
      b64(await derive("argon2id", MAX_MEMORY_KIB, 1)),
    );
    const atPasses = phc(
      "argon2id",
      "v=19",
      `m=64,t=${MAX_PASSES},p=1`,
      S,
      b64(await derive("argon2id", 64, MAX_PASSES)),
    );
    expect(await verifyPhc(PW, atMemory)).toBe(true);
    expect(await verifyPhc(PW, atPasses)).toBe(true);
    const tag = b64(new Uint8Array(32));
    const started = performance.now();
    await expect(verifyPhc(PW, phc("argon2id", "v=19", "m=4194304,t=1,p=1", S, tag))).rejects.toThrow(
      "Failed to verify password against the stored hash: Error: memory cost over 65536 KiB",
    );
    await expect(verifyPhc(PW, phc("argon2id", "v=19", "m=64,t=11,p=1", S, tag))).rejects.toThrow(
      "Failed to verify password against the stored hash: Error: time cost over 10",
    );
    // A missing m is argon2's default, under the bound; a cost argon2 refuses does not match before the bound applies.
    expect(await verifyPhc(PW, phc("argon2id", "v=19", "m=4194304,t=0,p=1", S, tag))).toBe(false);
    expect(performance.now() - started).toBeLessThan(50);
  });
});
