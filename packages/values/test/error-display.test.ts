// How a value is printed inside an error message: Convex's `stringifyValueForError` structure for plain data
// (npm-packages/convex/src/values/value.ts), but a class instance, a Map or an engine object is named, never
// opened. Serialising one used to put whatever it reached (for `ctx.db`: the transaction, the catalog, the
// store) in a message the client receives.
import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { displayValue, stringifyValueForError, toJsonValue } from "../src/index.ts";
import { runs, value } from "./arbitraries.ts";

const LIMIT = 16384;

/** Convex's algorithm, as the reference for plain data: `JSON.stringify` with its replacer, then the cut. */
function reference(v: unknown): string {
  const s = String(
    JSON.stringify(v, (_k, x) => (x === undefined ? "undefined" : typeof x === "bigint" ? `${x.toString()}n` : x)),
  );
  if (s.length <= LIMIT) return s;
  let at = LIMIT - "[...truncated]".length;
  const cp = s.codePointAt(at - 1);
  if (cp !== undefined && cp > 0xffff) at -= 1;
  return `${s.substring(0, at)}[...truncated]`;
}

class Vault {
  apiKey = "sk-live-SECRET-0123456789";
  // a reference to something large: what an engine object holds (the transaction, the store)
  store = { docs: Array.from({ length: 2000 }, (_, i) => ({ i, secret: `row-${i}-SECRET` })) };
  toJSON() {
    throw new Error("toJSON must not run");
  }
}

function messageOf(f: () => unknown): string {
  try {
    f();
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("did not throw");
}

describe("stringifyValueForError", () => {
  test("plain data prints exactly as Convex prints it, cut included", () => {
    fc.assert(
      fc.property(value, (v) => {
        expect(stringifyValueForError(v)).toBe(reference(v));
      }),
      { numRuns: runs(300) },
    );
    const samples: unknown[] = [
      undefined,
      null,
      [1, undefined, () => 1, Symbol("s"), Number.NaN, -0, Number.POSITIVE_INFINITY, 5n],
      { a: undefined, f: () => 1, s: Symbol("s"), n: 1n, nested: { "": [{}] }, 2: "int key first" },
      Object.assign(Object.create(null), { z: 1, a: "\u0000 \ud800" }),
      new ArrayBuffer(4),
      { bytes: new ArrayBuffer(4) },
      "x".repeat(LIMIT * 2),
      `${"x".repeat(LIMIT - 16)}😀😀😀`, // a surrogate pair at the cut
      Array.from({ length: 5000 }, (_, i) => ({ i })),
      { [`k${"x".repeat(LIMIT)}`]: 1 },
    ];
    for (const v of samples) expect(stringifyValueForError(v)).toBe(reference(v));
  });

  test("a class instance is named, never opened: no field of it, nor of what it references", () => {
    const vault = new Vault();
    for (const v of [vault, { nested: [vault] }, new Map([["k", vault]]), new Set([vault]), new Date(0)]) {
      const s = stringifyValueForError(v);
      expect(s).not.toContain("SECRET");
      expect(s.length).toBeLessThan(100);
    }
    expect(stringifyValueForError(vault)).toBe("Vault {…}");
    expect(stringifyValueForError({ nested: [vault] })).toBe('{"nested":[Vault {…}]}');
    expect(stringifyValueForError(new Map())).toBe("Map {…}");
    expect(stringifyValueForError(Object.create(Object.create(null)))).toBe("{…}");
  });

  test("no method or getter of a class instance runs", () => {
    let ran = false;
    class Lazy {
      get secret() {
        ran = true;
        return "SECRET";
      }
      toJSON() {
        ran = true;
        return "SECRET";
      }
    }
    expect(stringifyValueForError({ l: new Lazy() })).toBe('{"l":Lazy {…}}');
    expect(ran).toBe(false);
  });

  test("a cycle prints as [Circular] instead of throwing; a shared, acyclic reference prints twice", () => {
    const loop: Record<string, unknown> = { a: 1 };
    loop.self = loop;
    loop.list = [loop];
    expect(stringifyValueForError(loop)).toBe('{"a":1,"self":"[Circular]","list":["[Circular]"]}');
    const shared = { x: 1 };
    expect(stringifyValueForError({ p: shared, q: shared })).toBe('{"p":{"x":1},"q":{"x":1}}');
  });

  test("a huge or deep value costs no more than the message", () => {
    const wide: Record<string, number> = {};
    for (let i = 0; i < 200_000; i++) wide[`k${i}`] = i;
    expect(stringifyValueForError(wide).length).toBe(LIMIT);
    let deep: unknown = 1;
    for (let i = 0; i < 100_000; i++) deep = [deep];
    expect(stringifyValueForError(deep).length).toBe(LIMIT);
  });
});

describe("the unsupported-value message", () => {
  test("keeps Convex's structure: name, value, path, original object", () => {
    expect(messageOf(() => toJsonValue(new Vault() as never))).toBe("Vault {…} is not a supported value type.");
    expect(messageOf(() => toJsonValue({ a: [1, { v: new Vault() }], b: "keep" } as never))).toBe(
      'Vault {…} is not a supported value type (present at path .a[1].v in original object {"a":[1,{"v":Vault {…}}],"b":"keep"}).',
    );
    expect(messageOf(() => toJsonValue(new Set([1, new Vault()]) as never))).toBe(
      "Set[1,Vault {…}] is not a supported value type.",
    );
    expect(messageOf(() => toJsonValue({ f: async () => 1 } as never))).toBe(
      "AsyncFunction undefined is not a supported value type (present at path .f in original object {}).",
    );
  });

  test("a cyclic original object is printed, not a JSON.stringify failure", () => {
    const loop: Record<string, unknown> = { bad: new Date(0) };
    loop.self = loop;
    expect(messageOf(() => toJsonValue(loop as never))).toBe(
      'Date {…} is not a supported value type (present at path .bad in original object {"bad":Date {…},"self":"[Circular]"}).',
    );
  });
});

describe("displayValue (validator messages)", () => {
  test("plain values as before; anything else named, cycles marked", () => {
    expect(displayValue({ b: [1, "s", 2n], a: null })).toBe('{a: null, b: [1.0, "s", 2]}');
    const vault = new Vault();
    expect(displayValue({ v: vault } as never)).toBe("{v: Vault {…}}");
    expect(displayValue(new Map() as never)).toBe("Map {…}");
    const loop: Record<string, unknown> = { a: 1 };
    loop.self = loop;
    expect(displayValue(loop as never)).toBe("{a: 1.0, self: [Circular]}");
  });
});
