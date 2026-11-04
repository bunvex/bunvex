// The SQL drivers' hex forms of ids and keys (STUDY-133 PR 5): `internalIdHex` decodes an internal id's
// base64url straight to hex, `bytesToHex` and `keySha256Hex` without a Buffer, `compareInternalIds` without decoding;
// each must equal the plain forms.
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  bytesToHex,
  compareInternalIds,
  internalIdBytes,
  internalIdHex,
  internalIdString,
} from "../src/internal-id.ts";
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

test("compareInternalIds is the byte order of the ids, as Buffer.compare of the decoded bytes", () => {
  const sign = (n: number) => (n < 0 ? -1 : n > 0 ? 1 : 0);
  const ids: Uint8Array[] = [new Uint8Array(16), new Uint8Array(16).fill(255)];
  for (let i = 0; i < 2000; i++) {
    const b = crypto.getRandomValues(new Uint8Array(16));
    ids.push(b);
    // A near neighbour: the same bytes but one, so every digit position (the last one's 2 bits too) decides.
    const c = b.slice();
    c[i % 16] ^= 1 << (i % 8);
    ids.push(c);
  }
  for (let i = 1; i < ids.length; i++) {
    const [a, b] = [ids[i - 1], ids[i]];
    expect(sign(compareInternalIds(internalIdString(a), internalIdString(b)))).toBe(sign(Buffer.compare(a, b)));
    expect(compareInternalIds(internalIdString(a), internalIdString(a))).toBe(0);
  }
  // Engine-only ids sort after every internal id, among themselves as strings.
  const id = internalIdString(ids[2]);
  expect(compareInternalIds(id, "i1")).toBe(-1);
  expect(compareInternalIds("i1", id)).toBe(1);
  expect(compareInternalIds("i1", "i2")).toBe(-1);
});
