// The sort key encoder's fast paths write exactly the bytes of the general one (keys are stored, so any
// difference would corrupt indexes): the encoder below is the general algorithm, one byte at a time.
import { expect, test } from "bun:test";
import fc from "fast-check";
import { isCommitTsPlaceholder, MAX_COMMIT_TS } from "../src/commit-ts.ts";
import { valuesToKey } from "../src/sorting.ts";
import { isBytes, type Value } from "../src/value.ts";
import { keyPart, runs, value } from "./arbitraries.ts";

const utf8 = new TextEncoder();
function reference(values: (Value | undefined)[]): Uint8Array {
  const out: number[] = [];
  const escaped = (bytes: Uint8Array) => {
    for (const b of bytes) {
      out.push(b);
      if (b === 0) out.push(0xff);
    }
    out.push(0);
  };
  const f64 = new DataView(new ArrayBuffer(8));
  const write = (v: Value | undefined): void => {
    if (isCommitTsPlaceholder(v)) v = MAX_COMMIT_TS;
    if (v === undefined) return void out.push(0x01);
    if (v === null) return void out.push(0x03);
    if (typeof v === "bigint") {
      if (v === 0n) return void out.push(0x08);
      const width =
        v >= -128n && v <= 127n ? 1 : v >= -32768n && v <= 32767n ? 2 : v >= -(2n ** 31n) && v < 2n ** 31n ? 3 : 4;
      out.push(v < 0n ? 0x08 - width : 0x08 + width);
      const u = BigInt.asUintN(64, v);
      for (let i = (1 << (width - 1)) - 1; i >= 0; i--) out.push(Number((u >> BigInt(i * 8)) & 0xffn));
      return;
    }
    if (typeof v === "number") {
      f64.setFloat64(0, v);
      const b = new Uint8Array(f64.buffer);
      out.push(0x0d);
      if (b[0]! & 0x80) for (let i = 0; i < 8; i++) out.push(~b[i]! & 0xff);
      else {
        out.push(b[0]! | 0x80);
        for (let i = 1; i < 8; i++) out.push(b[i]!);
      }
      return;
    }
    if (typeof v === "boolean") return void out.push(v ? 0x0f : 0x0e);
    if (typeof v === "string") {
      out.push(0x10);
      return void escaped(utf8.encode(v));
    }
    if (isBytes(v)) {
      out.push(0x11);
      return void escaped(new Uint8Array(v));
    }
    if (Array.isArray(v)) {
      out.push(0x12);
      for (const e of v) write(e);
      return void out.push(0);
    }
    out.push(0x15);
    for (const k of Object.keys(v).sort()) {
      const e = (v as Record<string, Value>)[k];
      if (e === undefined) continue;
      escaped(utf8.encode(k));
      if (k === "") out.push(0xff);
      write(e);
    }
    out.push(0);
  };
  for (const v of values) write(v);
  return Uint8Array.from(out);
}

const strings = fc.oneof(
  fc.string({ unit: "binary", maxLength: 40 }),
  fc.string({
    unit: fc.constantFrom("a", "Z", "0", "\0", "é", "日", "😀", "\ud800", "\u007f", "\u0080"),
    maxLength: 70,
  }),
);

test("valuesToKey writes the general encoder's bytes", () => {
  fc.assert(
    fc.property(fc.array(fc.oneof(value, keyPart, strings), { maxLength: 4 }), (vs) => {
      expect(valuesToKey(vs)).toEqual(reference(vs));
    }),
    { numRuns: runs(20_000) },
  );
  // Long strings, past the writer's first buffer.
  for (const s of ["a".repeat(500), "é".repeat(300), `${"x".repeat(100)}\0${"y".repeat(100)}`])
    expect(valuesToKey([s, { [s]: s }])).toEqual(reference([s, { [s]: s }]));
});
