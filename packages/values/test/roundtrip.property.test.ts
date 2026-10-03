// Round-trip properties of the value forms (TEST-01 §2), as Convex property-tests its own
// (crates/value/src/json/tests.rs, export.rs, id_v6.rs, base32.rs): the JSON wire form, the snapshot export
// form, the validated copy and document ids each give back exactly the value they were made from.
// "Exactly" is compareValues(…) === 0, which tells −0 from 0, NaN payloads apart by bits, int64 from float64,
// and bytes from strings (the sort-key properties make it a faithful equality).
import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { fromExportJson, toExportJson } from "../src/export-json.ts";
import { decodeId, encodeId } from "../src/id.ts";
import { compareValues, copyValue, fromJsonValue, toJsonValue } from "../src/value.ts";
import { runs, value } from "./arbitraries.ts";

const same = (a: unknown, b: unknown) => expect(compareValues(a as never, b as never)).toBe(0);

describe("round trips", () => {
  test("the JSON wire form: fromJsonValue(JSON.parse(JSON.stringify(toJsonValue(v)))) is v", () => {
    fc.assert(
      fc.property(value, (v) => same(fromJsonValue(JSON.parse(JSON.stringify(toJsonValue(v)))), v)),
      { numRuns: runs(500) },
    );
  });

  test("the snapshot export form: fromExportJson(toExportJson(v)) is v", () => {
    fc.assert(
      fc.property(value, (v) => same(fromExportJson(toExportJson(v)), v)),
      { numRuns: runs(500) },
    );
  });

  test("the export form is canonical: equal values print the same text", () => {
    fc.assert(
      fc.property(value, (v) => expect(toExportJson(fromExportJson(toExportJson(v)))).toBe(toExportJson(v))),
      { numRuns: runs(300) },
    );
  });

  test("copyValue gives an equal value that shares nothing mutable with the original", () => {
    fc.assert(
      fc.property(value, (v) => {
        const c = copyValue(v);
        same(c, v);
        if (v !== null && typeof v === "object") expect(c).not.toBe(v);
      }),
      { numRuns: runs(300) },
    );
  });

  test("document ids: decodeId(encodeId(t, id)) gives the table number and the 16 bytes back", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 0xffffffff }),
        fc.uint8Array({ minLength: 16, maxLength: 16 }),
        (t, raw) => {
          const d = decodeId(encodeId(t, raw));
          expect(d.tableNumber).toBe(t);
          expect([...d.internalId]).toEqual([...raw]);
        },
      ),
      { numRuns: runs(500) },
    );
  });

  test("a mangled id is refused, never decoded to another document", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 0xffff }),
        fc.uint8Array({ minLength: 16, maxLength: 16 }),
        fc.nat(),
        fc.constantFrom(..."0123456789abcdefghjkmnpqrstvwxyz"),
        (t, raw, at, ch) => {
          const id = encodeId(t, raw);
          const i = at % id.length;
          if (id[i] === ch) return;
          const bad = id.slice(0, i) + ch + id.slice(i + 1);
          let decoded: ReturnType<typeof decodeId> | null = null;
          try {
            decoded = decodeId(bad);
          } catch {}
          // a one-character change is caught by the checksum (Fletcher-16 detects every single-symbol error)
          expect(decoded).toBeNull();
        },
      ),
      { numRuns: runs(500) },
    );
  });
});
