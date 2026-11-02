// The password hasher (AD-49, STUDY-201 C-2) against Convex Auth v2's `argon2id-wasm` (a test dependency only): the
// same salt gives the same PHC string byte for byte, each verifies the other's, and verification follows the stored
// string's own algorithm and parameters, as the Rust crate's does.
import { beforeAll, describe, expect, test } from "bun:test";
import { argon2 } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { argon2idPhc, verifyPhc } from "../src/password.ts";

type Wasm = {
  default: (init: { module_or_path: Uint8Array }) => Promise<unknown>;
  hash_password: (password: string, salt: Uint8Array) => string;
  verify_password: (password: string, hash: string) => boolean;
};
let wasm: Wasm;
beforeAll(async () => {
  // Its package exports only `dist`, which imports the `.wasm` through a bundler plugin: load the module directly.
  const pkg = join(dirname(createRequire(import.meta.url).resolve("argon2id-wasm/package.json")), "rust", "pkg");
  wasm = (await import(join(pkg, "argon2_wasm.js"))) as Wasm;
  await wasm.default({ module_or_path: readFileSync(join(pkg, "argon2_wasm_bg.wasm")) });
});

const saltOf = (seed: number) => new Uint8Array(16).map((_, i) => (i * 37 + seed) & 0xff);
const PASSWORDS = ["correct horse battery staple", "", "pässwörd 🔐 ñ", "a".repeat(200)];

describe("the same as argon2id-wasm", () => {
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

describe("verification follows the stored string", () => {
  const phc = (algorithm: string, params: string, salt: Uint8Array, tag: Buffer) =>
    `$${algorithm}$v=19$${params}$${Buffer.from(salt).toString("base64").replace(/=+$/, "")}$${tag.toString("base64").replace(/=+$/, "")}`;
  const derive = (algorithm: "argon2i" | "argon2d" | "argon2id", memory: number, passes: number, tagLength: number) =>
    new Promise<Buffer>((resolve, reject) =>
      argon2(
        algorithm,
        { message: "pw-12345678", nonce: saltOf(3), memory, passes, parallelism: 1, tagLength },
        (e, t) => (e ? reject(e) : resolve(t)),
      ),
    );

  test.each(["argon2i", "argon2d"] as const)(
    "%s, other parameters and tag length: as argon2id-wasm",
    async (algorithm) => {
      const hash = phc(algorithm, "m=1024,t=2,p=1", saltOf(3), await derive(algorithm, 1024, 2, 24));
      expect(await verifyPhc("pw-12345678", hash)).toBe(true);
      expect(wasm.verify_password("pw-12345678", hash)).toBe(true);
      expect(await verifyPhc("pw-87654321", hash)).toBe(false);
    },
  );

  test("no version is 0x13", async () => {
    const hash = phc("argon2id", "m=1024,t=2,p=1", saltOf(3), await derive("argon2id", 1024, 2, 32)).replace(
      "$v=19",
      "",
    );
    expect(await verifyPhc("pw-12345678", hash)).toBe(true);
    expect(wasm.verify_password("pw-12345678", hash)).toBe(true);
  });

  test.each([
    ["not a PHC string", "plaintext"],
    ["unsupported algorithm scrypt", "$scrypt$v=19$m=1024,t=2,p=1$c2FsdHNhbHQ$aGFzaGhhc2g"],
    ["unsupported version 16", "$argon2id$v=16$m=1024,t=2,p=1$c2FsdHNhbHQ$aGFzaGhhc2g"],
    ["the parameters must be m, t and p", "$argon2id$v=19$m=1024,t=2$c2FsdHNhbHQ$aGFzaGhhc2g"],
    ["invalid base64", "$argon2id$v=19$m=1024,t=2,p=1$c2Fs*$aGFzaGhhc2g"],
  ])("a stored hash it cannot read throws: %s", async (why, hash) => {
    await expect(verifyPhc("pw", hash)).rejects.toThrow(`Failed to verify password against the stored hash: ${why}`);
  });
});
