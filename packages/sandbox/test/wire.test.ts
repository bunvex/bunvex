// The bridge's codec and messages (STUDY-171 §8.3): values round-trip exactly; what is not a value comes back as an
// object of the same kind and class name, from no realm of the host's (as an app's objects are under `vm`), so the
// engine's checks fail with the same words; the host refuses what a child sends that it never makes.
import { describe, expect, test } from "bun:test";
import vm from "node:vm";
import { anyApi, functionName, getFunctionAddress } from "@bunvex/protocol";
import {
  commitTsPlaceholder,
  copyValue,
  isCommitTsPlaceholder,
  stringifyValueForError,
  type Value,
} from "@bunvex/values";
import { BadMessageError, decode, encode, parseChildMessage } from "../src/index.ts";
import { MAX_WIRE_ENTRIES } from "../src/wire.ts";

/** What the host gets of `x`: the child's encoding, sent as JSON, checked. */
const across = (x: unknown) => decode(JSON.parse(JSON.stringify(encode(x))), true);

/** The engine's error for a value it cannot copy, or null. */
const copyError = (x: unknown) => {
  try {
    copyValue(x as Value);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
};

describe("values", () => {
  test("round-trip exactly: special floats, int64 of any size, bytes, undefined, nesting, field order", () => {
    const bytes = new Uint8Array([0, 1, 255]).buffer;
    const x = {
      z: 1,
      a: [Number.NaN, -0, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 2n ** 70n, -5n, undefined],
      b: bytes,
      s: "ünï \ud800 lone",
      n: null,
      t: true,
      u: undefined,
      deep: { deeper: [{ x: [] }] },
    };
    const y = across(x) as typeof x;
    expect(Object.keys(y)).toEqual(Object.keys(x));
    expect(Number.isNaN(y.a[0])).toBe(true);
    expect(Object.is(y.a[1], -0)).toBe(true);
    expect(y.a.slice(2)).toEqual([Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 2n ** 70n, -5n, undefined]);
    expect(new Uint8Array(y.b as ArrayBuffer)).toEqual(new Uint8Array([0, 1, 255]));
    expect(y.s).toBe(x.s);
    expect("u" in y && y.u === undefined).toBe(true);
    expect(y.deep).toEqual(x.deep);
  });

  test("a key that starts with $ is a key, never a tag; __proto__ is a key", () => {
    const x = JSON.parse('{"$x":{"k":"symbol"},"__proto__":{"polluted":1},"$u":0}');
    const y = across(x) as Record<string, unknown>;
    expect(Object.keys(y)).toEqual(["$x", "__proto__", "$u"]);
    expect(y.$u).toBe(0);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(y)).toBe(Object.prototype);
  });

  test("the commit timestamp placeholder is the placeholder", () => {
    expect(
      isCommitTsPlaceholder(
        across({ at: commitTsPlaceholder }) && (across({ at: commitTsPlaceholder }) as { at: unknown }).at,
      ),
    ).toBe(true);
  });

  test("a cycle is the same cycle", () => {
    const o: Record<string, unknown> = { a: [1] };
    o.self = o;
    (o.a as unknown[]).push(o.a);
    const y = across(o) as Record<string, unknown>;
    expect(y.self).toBe(y);
    expect((y.a as unknown[])[1]).toBe(y.a);
    expect(copyError(y)).toBe(copyError(o));
  });
});

describe("what is not a value fails the engine's checks with the same words", () => {
  // An app's objects come from its own realm (its `vm` context), as under the `vm` executor.
  const realm = vm.createContext({});
  const theirs = (code: string) => vm.runInContext(code, realm);
  for (const [name, code] of [
    ["a class instance", "new (class Point { constructor() { this.x = 1 } })()"],
    ["a Date", "new Date(0)"],
    ["a Set", "new Set([1])"],
    ["a Map", "new Map([[1, 2]])"],
    ["a function", "(() => 1)"],
    ["an async function", "(async () => 1)"],
    ["a generator", "(function* () {})"],
    ["a symbol", "Symbol('s')"],
    ["a symbol without a description", "Symbol()"],
    ["a typed array", "new Uint8Array(2)"],
    ["an object without a prototype's constructor", "Object.create({})"],
    ["inside an object", "({ v: [1, new Set()] })"],
    // a Set's or Map's entries print (STUDY-18 §9): every size, nested, subclasses, cycles
    ["an empty Set", "new Set()"],
    ["a Set of many", 'new Set([1, "two", null, [3], { four: 4n }, undefined, NaN, new ArrayBuffer(1)])'],
    ["an empty Map", "new Map()"],
    ["a Map of many", 'new Map([["a", 1], [2, [true]], [null, { b: "c" }]])'],
    ["a Set of Sets and Maps", "new Set([new Set([1]), new Map([[1, 2]])])"],
    ["a subclass of Set holding one of Map", "new (class Tags extends Set {})([new (class Index extends Map {})()])"],
    [
      "a Set and a Map holding themselves",
      "(() => { const s = new Set([1]); s.add(s); const m = new Map(); m.set(m, [m]); s.add(m); return s; })()",
    ],
    ["a Set past the entries carried", "new Set(Array.from({ length: 20000 }, (_, i) => i))"],
    ["a Set in an array in an object", '({ x: 1, m: [0, new Map([["k", new Set(["s"])]])] })'],
    ["a subclass of Date", "new (class Day extends Date {})(0)"],
    ["an object with the ArrayBuffer tag", '({ [Symbol.toStringTag]: "ArrayBuffer", a: 1 })'],
  ] as const)
    test(name, () => {
      const x = theirs(code);
      expect(copyError(across(x))).toBe(copyError(x));
      expect(stringifyValueForError(across({ v: x }))).toBe(stringifyValueForError({ v: x }));
    });
});

describe("a Set, a Map or a Date: the host's own, with the app's entries, time and class name", () => {
  const realm = vm.createContext({});
  test("the host gets a real one, its entries in order, cycles kept", () => {
    const s = across(vm.runInContext("(() => { const s = new Set([1, 'a']); s.add(s); return s; })()", realm));
    expect(s instanceof Set).toBe(true);
    expect([...(s as Set<unknown>)].slice(0, 2)).toEqual([1, "a"]);
    expect([...(s as Set<unknown>)][2]).toBe(s);
    const m = across(vm.runInContext("new Map([[{ a: 1 }, [2n]]])", realm)) as Map<unknown, unknown>;
    expect(m instanceof Map && [...m]).toEqual([[{ a: 1 }, [2n]]]);
    const self = across(vm.runInContext("(() => { const m = new Map(); m.set(m, [m]); return m; })()", realm)) as Map<
      unknown,
      unknown
    >;
    const [[key, value]] = [...self] as [[unknown, unknown[]]];
    expect([key === self, value[0] === self]).toEqual([true, true]);
    const d = across(vm.runInContext("new Date(5)", realm));
    expect(d instanceof Date && (d as Date).getTime()).toBe(5);
    expect(Number.isNaN((across(vm.runInContext("new Date(NaN)", realm)) as Date).getTime())).toBe(true);
  });

  test("a subclass keeps its class name, and its kind's methods", () => {
    const t = across(vm.runInContext("new (class Tags extends Set {})([1])", realm)) as Set<unknown>;
    expect([t.constructor.name, t.has(1), t.size]).toEqual(["Tags", true, 1]);
    const d = across(vm.runInContext("new (class Day extends Date {})(7)", realm)) as Date;
    expect([d.constructor.name, d.valueOf()]).toEqual(["Day", 7]);
  });

  test("at most MAX_WIRE_ENTRIES entries cross", () => {
    const big = encode(new Set(Array.from({ length: MAX_WIRE_ENTRIES + 5 }, (_, i) => i))) as { $x: { e: unknown[] } };
    expect(big.$x.e.length).toBe(MAX_WIRE_ENTRIES);
  });

  for (const [name, wire] of [
    ["entries that are not a list", { $x: { k: "set", c: "Set", e: 1 } }],
    ["too many entries", { $x: { k: "set", c: "Set", e: new Array(MAX_WIRE_ENTRIES + 1).fill(1) } }],
    ["a Map entry that is not a pair", { $x: { k: "map", c: "Map", e: [[1]] } }],
    ["a Set without its class name", { $x: { k: "set", e: [] } }],
    ["a Date without its time", { $x: { k: "date", c: "Date" } }],
    ["a Date whose time is not a number", { $x: { k: "date", c: "Date", t: "5" } }],
  ] as const)
    test(`refused: ${name}`, () => {
      expect(() => decode(wire, true)).toThrow(BadMessageError);
    });
});

describe("function references", () => {
  test("a reference's name or path, or the error reading it threw", () => {
    expect(getFunctionAddress(across(anyApi.messages!.list))).toEqual({ name: "messages:list" });
    expect(getFunctionAddress(across({ [functionName]: "a:b" }))).toEqual({ name: "a:b" });
    const broken = across(anyApi.messages) as object;
    expect(() => getFunctionAddress(broken)).toThrow("API path is expected to be of the form");
  });
});

describe("the host refuses what a child never sends", () => {
  for (const [name, wire] of [
    ["an unknown tag", { $evil: 1 }],
    ["two keys, one a tag", { $u: 0, x: 1 }],
    ["a bad int64", { $n: "1e3" }],
    ["a bad float", { $f: "1.5" }],
    ["a cycle past the root", { $c: 3 }],
    ["an escaped object that is not entries", { $o: { a: 1 } }],
    ["an unknown kind", { $x: { k: "proxy" } }],
  ] as const)
    test(name, () => {
      expect(() => decode(wire, true)).toThrow(BadMessageError);
    });

  test("an operation and an answer: their shape checked, their report a finite time", () => {
    const report = {
      ran: 0.5,
      time: false,
      env: ["X"],
      links: [["open", 1, null, ["items", false]]] as [string, number, number | null, unknown][],
    };
    expect(parseChildMessage(JSON.stringify({ t: "op", id: 1, op: 2, name: "db.get", args: ["x"], report }))).toEqual({
      t: "op",
      id: 1,
      op: 2,
      name: "db.get",
      args: ["x"],
      report,
    });
    expect(parseChildMessage(JSON.stringify({ t: "done", id: 1, ok: true, value: null, report })).t).toBe("done");
    for (const bad of [
      { t: "op", id: 1, op: 2, name: "db.get", args: "x", report },
      { t: "op", id: 1, op: 2, name: "db.get", args: [], report: { ...report, ran: -1 } },
      { t: "op", id: 1, op: 2, name: "db.get", args: [], report: { ...report, env: [1] } },
      { t: "op", id: 1, op: 2, name: "db.get", args: [], report: { ...report, links: [["open", 1, null]] } },
      { t: "op", id: 1, op: 2, name: "db.get", args: [], report: { ...report, links: [["open", -1, null, []]] } },
      { t: "done", id: 1, ok: true, report },
      { t: "done", id: 1, ok: false, error: { k: "mystery" }, report },
      { t: "done", id: 1, ok: false, error: { k: "op", op: -1, stack: null }, report },
    ])
      expect(() => parseChildMessage(JSON.stringify(bad))).toThrow(BadMessageError);
  });
});
