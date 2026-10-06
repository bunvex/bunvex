// The fast paths of two functions every HTTP answer goes through (the value formats of /api/query, …):
// they give exactly what the general algorithms give. compareUtf8 against Buffer's byte order, lone surrogates
// included (Buffer encodes one as U+FFFD); formatExportFloat against ryu's layout rules on JS's digits.
import { expect, test } from "bun:test";
import fc from "fast-check";
import { compareUtf8 } from "../src/bytes.ts";
import { formatExportFloat } from "../src/export-json.ts";
import { runs } from "./arbitraries.ts";

const unit = fc.oneof(
  fc.integer({ min: 0, max: 0xffff }).map((c) => String.fromCharCode(c)),
  fc.constantFrom("a", "b", "\0", "é", "\ud83d", "\ude00", "\ud800", "\udfff", "", "￿", "�", "😀"),
);
const str = fc.string({ unit, maxLength: 8 });
const byBuffer = (a: string, b: string) => Math.sign(Buffer.compare(Buffer.from(a), Buffer.from(b)));

test("compareUtf8 orders as Buffer's UTF-8 bytes, for any UTF-16 strings", () => {
  fc.assert(
    fc.property(str, str, (a, b) => {
      expect(Math.sign(compareUtf8(a, b))).toBe(byBuffer(a, b));
    }),
    { numRuns: runs(20_000) },
  );
  // Strings that share a prefix, where the first difference (or the end of one) decides.
  fc.assert(
    fc.property(str, str, str, (p, a, b) => {
      expect(Math.sign(compareUtf8(p + a, p + b))).toBe(byBuffer(p + a, p + b));
    }),
    { numRuns: runs(20_000) },
  );
});

/** serde_json's float layout (ryu's `format64`) on JS's shortest digits: the general algorithm. */
function reference(n: number): string {
  if (Object.is(n, 0)) return "0.0";
  if (Object.is(n, -0)) return "-0.0";
  const sign = n < 0 ? "-" : "";
  const [mant, expStr] = Math.abs(n).toExponential().split("e") as [string, string];
  const digits = mant.replace(".", "");
  const length = digits.length;
  const kk = Number(expStr) + 1;
  const k = kk - length;
  let out: string;
  if (k >= 0 && kk <= 16) out = `${digits}${"0".repeat(k)}.0`;
  else if (kk > 0 && kk <= 16) out = `${digits.slice(0, kk)}.${digits.slice(kk)}`;
  else if (kk > -5 && kk <= 0) out = `0.${"0".repeat(-kk)}${digits}`;
  else if (length === 1) out = `${digits}e${kk > 0 ? "+" : ""}${kk - 1}`;
  else out = `${digits[0]}.${digits.slice(1)}e${kk > 0 ? "+" : ""}${kk - 1}`;
  return sign + out;
}

test("formatExportFloat is serde_json's layout for every finite double", () => {
  const edges = [
    1e-5, 9.999999999999999e-6, 1e16, 9999999999999998, 1e15, 0.1, 123, -0.5, 5e-324, 1.7976931348623157e308,
  ];
  for (const n of [...edges, ...edges.map((x) => -x)]) expect(formatExportFloat(n)).toBe(reference(n));
  fc.assert(
    fc.property(
      fc.oneof(
        fc.double({ noNaN: true, noDefaultInfinity: true }),
        fc.integer({ min: -(2 ** 53), max: 2 ** 53 }),
        fc.double({ min: -1e17, max: 1e17, noNaN: true }),
        fc.double({ min: -1e-3, max: 1e-3, noNaN: true }),
      ),
      (n) => {
        expect(formatExportFloat(n)).toBe(reference(n));
      },
    ),
    { numRuns: runs(50_000) },
  );
});
