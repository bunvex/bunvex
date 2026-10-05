// encodeId and idTableNumber run on every insert and on every string a table summary sees: their fast paths
// give exactly what the general algorithms give (below, written plainly), valid and invalid ids alike.
import { expect, test } from "bun:test";
import fc from "fast-check";
import { decodeId, encodeId, idTableNumber } from "../src/id.ts";
import { runs } from "./arbitraries.ts";

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
function referenceEncode(tableNumber: number, internalId: Uint8Array): string {
  const vint: number[] = [];
  let n = tableNumber;
  while (n >= 0x80) {
    vint.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  vint.push(n);
  const head = [...vint, ...internalId];
  let c0 = 0;
  let c1 = 0;
  for (const b of head) {
    c0 = (c0 + b) & 0xff;
    c1 = (c1 + c0) & 0xff;
  }
  const footer = (c1 << 8) | c0;
  const bytes = [...head, footer & 0xff, footer >> 8];
  let out = "";
  let acc = 0;
  let bits = 0;
  for (const b of bytes) {
    acc = ((acc << 8) | b) & 0xfff;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(acc >> bits) & 31];
    }
  }
  if (bits > 0) out += ALPHABET[(acc << (5 - bits)) & 31];
  return out;
}
const referenceTable = (s: string): number | null => {
  try {
    return decodeId(s).tableNumber;
  } catch {
    return null;
  }
};

const tableNumber = fc.oneof(
  fc.integer({ min: 1, max: 0xffffffff }),
  fc.integer({ min: 1, max: 200 }),
  fc.integer({ min: 10_001, max: 20_000 }),
  fc.constantFrom(127, 128, 16_383, 16_384, 2_097_151, 2_097_152, 0xffffffff),
);
const internal = fc.uint8Array({ minLength: 16, maxLength: 16 });

test("encodeId writes the general algorithm's id", () => {
  fc.assert(
    fc.property(tableNumber, internal, (t, i) => {
      expect(encodeId(t, i)).toBe(referenceEncode(t, i));
    }),
    { numRuns: runs(20_000) },
  );
});

test("idTableNumber is decodeId's table number, or null when decodeId refuses the string", () => {
  const mutate = (s: string, at: number, c: string) => s.slice(0, at % s.length) + c + s.slice((at % s.length) + 1);
  fc.assert(
    fc.property(
      tableNumber,
      internal,
      fc.nat(),
      fc.constantFrom(...ALPHABET.split(""), "A", "i", "l", "o", "u", "-"),
      fc.boolean(),
      (t, i, at, c, corrupt) => {
        const id = encodeId(t, i);
        const s = corrupt ? mutate(id, at, c) : id;
        expect(idTableNumber(s)).toBe(referenceTable(s));
        expect(idTableNumber(s + c)).toBe(referenceTable(s + c));
        expect(idTableNumber(s.slice(0, -1))).toBe(referenceTable(s.slice(0, -1)));
      },
    ),
    { numRuns: runs(20_000) },
  );
  fc.assert(
    fc.property(fc.string({ maxLength: 40 }), (s) => {
      expect(idTableNumber(s)).toBe(referenceTable(s));
    }),
    { numRuns: runs(5_000) },
  );
});
