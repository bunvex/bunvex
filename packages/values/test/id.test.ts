import { describe, expect, test } from "bun:test";
import { decodeId, encodeId, idTableNumber } from "../src/id.ts";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

describe("document ids (Convex format)", () => {
  test("decodes a real Convex id and encodes it back to the same string", () => {
    // Found in the Convex repository; decoding it checks format compatibility.
    const real = "kg27rxfv99gzp01wmph0gvt92d6hnvy6";
    const d = decodeId(real);
    expect(d.tableNumber).toBe(540);
    expect(hex(d.internalId)).toBe("7c75fb4a61fb003ca5a2086f49134d1a");
    expect((d.internalId[14] << 8) | d.internalId[15]).toBe(19738); // the day: 2024-01-17
    expect(encodeId(d.tableNumber, d.internalId)).toBe(real);
  });

  test("round trip across every VInt size; user tables give 32 characters", () => {
    for (const n of [1, 127, 128, 16_383, 16_384, 2_097_151, 2_097_152, 268_435_455, 268_435_456, 0xffffffff]) {
      for (let i = 0; i < 50; i++) {
        const internal = crypto.getRandomValues(new Uint8Array(16));
        const s = encodeId(n, internal);
        expect(s.length).toBeGreaterThanOrEqual(31);
        expect(s.length).toBeLessThanOrEqual(37);
        const d = decodeId(s);
        expect(d.tableNumber).toBe(n);
        expect(hex(d.internalId)).toBe(hex(internal));
      }
    }
    expect(encodeId(10_001, new Uint8Array(16)).length).toBe(32);
  });

  test("rejects what is not an id, with Convex's messages", () => {
    const good = encodeId(10_001, crypto.getRandomValues(new Uint8Array(16)));
    expect(() => decodeId(good.slice(0, -1))).toThrow("Invalid ID length 31");
    expect(() => decodeId(`${good}0`)).toThrow("Unable to decode ID");
    expect(() => decodeId(good.toUpperCase())).toThrow("wasn't valid base32");
    for (const bad of "ilou-_ ") expect(() => decodeId(bad + good.slice(1))).toThrow("wasn't valid base32");
    expect(() => decodeId("fd401950-6e52-4808-8fc2-562501ebbfc0")).toThrow("Unable to decode ID");
    expect(() => decodeId(encodeId(1, new Uint8Array(16)).replace(/^../, "00"))).toThrow("Invalid table number");
    expect(idTableNumber("nope")).toBeNull();
    // Non-canonical spelling: a 31-character id (table < 128, 19 bytes = 152 of 155 bits) has 3 unused
    // trailing bits; a string with them set would decode to the same id, so it is refused.
    const short = encodeId(5, crypto.getRandomValues(new Uint8Array(16)));
    const last = ALPHABET.indexOf(short[30]);
    expect(last & 0b111).toBe(0);
    expect(() => decodeId(short.slice(0, 30) + ALPHABET[last | 1])).toThrow("Invalid ID length 31");
  });

  test("the checksum catches every single-character change", () => {
    const s = encodeId(10_001, crypto.getRandomValues(new Uint8Array(16)));
    let caught = 0;
    let total = 0;
    for (let i = 0; i < s.length; i++)
      for (const c of ALPHABET) {
        if (c === s[i]) continue;
        total++;
        try {
          decodeId(s.slice(0, i) + c + s.slice(i + 1));
        } catch {
          caught++;
        }
      }
    // Fletcher-16 catches all single-symbol errors except rare byte-value aliasing (0x00 vs 0xff).
    expect(caught / total).toBeGreaterThan(0.99);
  });
});
