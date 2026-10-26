// STUDY-194 §4.2, STUDY-190 PR 2a: the call boundary's codec. Any request and any outcome (any value as the result
// or the arguments, any read set, any write set) comes back from its text as it was; a message that does not parse is
// refused, naming where.
import { describe, expect, test } from "bun:test";
import type { Value } from "@bunvex/values";
import fc from "fast-check";
import {
  type CallOutcome,
  type CallRequest,
  decodeCallOutcome,
  decodeCallRequest,
  encodeCallOutcome,
  encodeCallRequest,
  MalformedCallMessageError,
} from "../src/call-wire.ts";
import { parseValue, stringifyValue } from "../src/engine.ts";
import { runs } from "./property-runs.ts";
import { text, value } from "./value-arbitraries.ts";

const key = fc.uint8Array({ maxLength: 24 });
const id = fc.string({ minLength: 1, maxLength: 32 });
const ts = fc.bigInt({ min: 0n, max: 2n ** 64n - 1n });
const count = fc.nat({ max: Number.MAX_SAFE_INTEGER });
const optText = fc.option(text, { nil: null });

const request: fc.Arbitrary<CallRequest> = fc.record({
  id: fc.nat(),
  kind: fc.constantFrom("query" as const, "mutation" as const),
  name: text,
  args: value.map((v) => stringifyValue(v)),
  internal: fc.boolean(),
  session: fc.option(fc.record({ sessionId: text, requestId: fc.nat() }), { nil: null }),
  ts,
  now: fc.oneof(fc.double({ min: 0, max: 1e15, noNaN: true }), fc.nat()),
  identity: fc.option(fc.json(), { nil: null }),
  systemIdentity: fc.boolean(),
  request: fc.option(fc.json(), { nil: null }),
  tracked: fc.boolean(),
  journal: optText,
  refused: fc.boolean(),
});

const outcome: fc.Arbitrary<CallOutcome> = fc.record({
  id: fc.nat(),
  status: fc.constantFrom("ok" as const, "failed" as const, "refused" as const, "replayed" as const),
  result: fc.option(
    value.map((v) => stringifyValue(v)),
    { nil: null },
  ),
  reads: fc.array(fc.record({ index: id, lo: key, hi: key }), { maxLength: 8 }),
  searchReads: fc.array(
    fc.record({
      index: id,
      terms: fc.array(fc.record({ term: text, prefix: fc.boolean() }), { maxLength: 3 }),
      filters: fc.array(fc.tuple(text, text), { maxLength: 3 }),
    }),
    { maxLength: 3 },
  ),
  identityObserved: fc.boolean(),
  observedTime: fc.boolean(),
  endCursor: optText,
  documentsRead: count,
  bytesRead: count,
  writes: fc.option(
    fc.record({
      docs: fc.array(
        fc.record({
          table: id,
          id,
          json: fc.option(
            value.map((v) => stringifyValue(v)),
            { nil: null },
          ),
          prevTs: fc.option(ts, { nil: null }),
        }),
        { maxLength: 4 },
      ),
      idx: fc.array(
        fc.record({
          index: id,
          key,
          table: fc.option(id, { nil: null }),
          id: fc.option(id, { nil: null }),
          docId: fc.option(id, { nil: null }),
        }),
        { maxLength: 6 },
      ),
      touches: fc.array(fc.record({ index: id, key, id: fc.constant(null) }), { maxLength: 2 }),
    }),
    { nil: null },
  ),
});

describe("the call boundary's codec", () => {
  test("any request round-trips", () => {
    fc.assert(
      fc.property(request, (r) => {
        expect(decodeCallRequest(encodeCallRequest(r))).toEqual(r);
      }),
      { numRuns: runs(300) },
    );
  });

  test("any outcome round-trips: its value, its read set, its write set", () => {
    fc.assert(
      fc.property(outcome, (o) => {
        expect(decodeCallOutcome(encodeCallOutcome(o))).toEqual(o);
      }),
      { numRuns: runs(300) },
    );
  });

  test("any value comes back as itself through the request's arguments and the outcome's result", () => {
    fc.assert(
      fc.property(value, (v) => {
        const r = decodeCallRequest(
          encodeCallRequest({
            id: 1,
            kind: "query",
            name: "m:f",
            args: stringifyValue(v),
            internal: false,
            session: null,
            ts: 1n,
            now: 1,
            identity: null,
            systemIdentity: false,
            request: null,
            tracked: false,
            journal: null,
            refused: false,
          }),
        );
        expect(parseValue(r.args)).toEqual(v as Value);
      }),
      { numRuns: runs(300) },
    );
  });

  test("a message cut anywhere is refused, naming the field", () => {
    fc.assert(
      fc.property(outcome, fc.nat(), (o, at) => {
        const s = encodeCallOutcome(o);
        const cut = s.slice(0, at % s.length);
        let error: unknown;
        try {
          decodeCallOutcome(cut);
        } catch (e) {
          error = e;
        }
        expect(error).toBeInstanceOf(MalformedCallMessageError);
        expect((error as MalformedCallMessageError).path).not.toBe("");
      }),
      { numRuns: runs(300) },
    );
    fc.assert(
      fc.property(request, fc.nat(), (r, at) => {
        const s = encodeCallRequest(r);
        expect(() => decodeCallRequest(s.slice(0, at % s.length))).toThrow(MalformedCallMessageError);
      }),
      { numRuns: runs(300) },
    );
  });

  test("a message with anything after its last field is refused", () => {
    fc.assert(
      fc.property(outcome, fc.string({ minLength: 1, maxLength: 4 }), (o, tail) => {
        expect(() => decodeCallOutcome(encodeCallOutcome(o) + tail)).toThrow(/A malformed call outcome: end: /);
      }),
      { numRuns: runs(100) },
    );
  });

  const sample: CallOutcome = {
    id: 7,
    status: "ok",
    result: "1",
    reads: [
      { index: "i1", lo: new Uint8Array([1]), hi: new Uint8Array([2]) },
      { index: "i2", lo: new Uint8Array([3, 4]), hi: new Uint8Array([5]) },
    ],
    searchReads: [],
    identityObserved: false,
    observedTime: false,
    endCursor: null,
    documentsRead: 1,
    bytesRead: 2,
    writes: null,
  };

  test("the error names the field and the item: a second interval's bound, a kind, the header", () => {
    const s = encodeCallOutcome(sample);
    // The second interval's `hi`, `1:` + one byte, cut to a length past the end.
    const i = s.lastIndexOf("1:\u0005");
    expect(() => decodeCallOutcome(`${s.slice(0, i)}9:${s.slice(i + 2)}`)).toThrow(
      "A malformed call outcome: reads[1].hi: a string of 9 characters",
    );
    expect(() => decodeCallOutcome(s.replace("o7:1:k", "o7:1:z"))).toThrow(
      'A malformed call outcome: status: unknown status "z"',
    );
    expect(() => decodeCallOutcome(`c${s.slice(1)}`)).toThrow('A malformed call outcome: header: expected "o"');
    expect(() => decodeCallOutcome(s.replace("o7:", "o7x:"))).toThrow(
      'A malformed call outcome: header: expected a number, got "7x"',
    );
  });

  test("a key byte past 255, a flag other than 0 or 1, a count past the message are refused", () => {
    const s = encodeCallOutcome(sample);
    expect(() => decodeCallOutcome(s.replace("1:\u0005", "1:ą"))).toThrow(
      "A malformed call outcome: reads[1].hi: a byte past 255",
    );
    const flags = encodeCallOutcome({ ...sample, reads: [] });
    expect(() => decodeCallOutcome(flags.replace("1:k1:10:0:", "1:k1:12:0:"))).toThrow(
      "A malformed call outcome: identityObserved: expected 0 or 1, got 2",
    );
    expect(() => decodeCallOutcome(s.replace(":2:2:", ":2:99999:"))).toThrow(
      /A malformed call outcome: reads: 99999 items, with \d+ characters left/,
    );
  });
});
