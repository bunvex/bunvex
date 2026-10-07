// The SQL drivers' hex forms of ids and keys (STUDY-133 PR 5): `internalIdHex` decodes an internal id's
// base64url straight to hex, `bytesToHex` and `keySha256Hex` without a Buffer; each must equal the plain forms.
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { bytesToHex, internalIdBytes, internalIdHex, internalIdString } from "../src/internal-id.ts";
import { keySha256, keySha256Hex } from "../src/persistence/split.ts";

const hexOf = (b: Uint8Array) => Buffer.from(b).toString("hex");

test("internalIdHex and bytesToHex equal the Buffer forms", () => {
  for (let i = 0; i < 5000; i++) {
    const b = crypto.getRandomValues(new Uint8Array(16));
    const id = internalIdString(b);
    expect(internalIdHex(id)).toBe(hexOf(b));
    expect(bytesToHex(b)).toBe(hexOf(b));
  }
  for (const n of [0, 1, 255, 256, 257, 3000]) {
    const b = crypto.getRandomValues(new Uint8Array(n));
    expect(bytesToHex(b)).toBe(hexOf(b));
  }
});

test("internalIdHex refuses what internalIdBytes refuses", () => {
  const bad = [
    "",
    "x",
    "AAAAAAAAAAAAAAAAAAAAAB",
    "AAAAAAAAAAAAAAAAAAAA*A",
    "AAAAAAAAAAAAAAAAAAAAAAA",
    7 as unknown as string,
  ];
  for (const s of bad) {
    let plain: unknown = null;
    let fast: unknown = null;
    try {
      internalIdBytes(s);
    } catch (e) {
      plain = e;
    }
    try {
      internalIdHex(s);
    } catch (e) {
      fast = e;
    }
    expect(plain).not.toBeNull();
    expect(fast).not.toBeNull();
  }
});

test("keySha256 and keySha256Hex are the SHA-256 of the whole key", () => {
  for (const n of [0, 1, 40, 2500, 6000]) {
    const k = crypto.getRandomValues(new Uint8Array(n));
    const want = createHash("sha256").update(k).digest("hex");
    expect(keySha256Hex(k)).toBe(want);
    expect(hexOf(keySha256(k))).toBe(want);
  }
});
