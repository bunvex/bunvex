// Values as JavaScript literals, the syntax Convex's dashboard uses (STUDY-12 D9): `{ name: "Ada", n: 1,
// credits: 10n, tags: ["a"], raw: Bytes("AAE="), gone: undefined }`. JSON is a subset of it. Parsed by hand —
// never evaluated — into our Values; `undefined` is the "remove this field" marker. Errors carry the offset
// where they are, so an editor can underline it.
import type { Value } from "../data-source.ts";
import { decodeInt64, encodeInt64, valueType } from "../filters.ts";

/** What `undefined` parses to: a field that should not be there (unset / removed). */
export const UNSET: unique symbol = Symbol("unset");
export type Literal = Value | typeof UNSET;

export type ParseResult<T = Literal> = { ok: true; value: T } | { ok: false; error: string; offset: number };

class Fail extends Error {
  constructor(
    message: string,
    readonly offset: number,
  ) {
    super(message);
  }
}

const IDENT = /[A-Za-z_$][A-Za-z0-9_$]*/y;
const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
const BIGINT = /-?(?:0|[1-9][0-9]*)n/y;
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

class Parser {
  i = 0;
  constructor(readonly s: string) {}

  fail(message: string, at = this.i): never {
    throw new Fail(message, at);
  }

  /** Whitespace and comments. */
  skip() {
    const s = this.s;
    for (;;) {
      while (this.i < s.length && /\s/.test(s[this.i]!)) this.i++;
      if (s.startsWith("//", this.i)) {
        const end = s.indexOf("\n", this.i);
        this.i = end < 0 ? s.length : end + 1;
      } else if (s.startsWith("/*", this.i)) {
        const end = s.indexOf("*/", this.i + 2);
        if (end < 0) this.fail("Unclosed comment");
        this.i = end + 2;
      } else return;
    }
  }

  match(re: RegExp): string | null {
    re.lastIndex = this.i;
    const m = re.exec(this.s);
    if (!m) return null;
    this.i += m[0].length;
    return m[0];
  }

  expect(ch: string) {
    this.skip();
    if (this.s[this.i] !== ch)
      this.fail(this.i >= this.s.length ? `Expected "${ch}" before the end` : `Expected "${ch}"`);
    this.i++;
  }

  value(top = false): Literal {
    this.skip();
    const s = this.s;
    const c = s[this.i];
    if (c === undefined) this.fail("Expected a value");
    if (c === "{") return this.object();
    if (c === "[") return this.array();
    if (c === '"' || c === "'") return this.string();
    const start = this.i;
    const big = this.match(BIGINT);
    if (big !== null) {
      const n = BigInt(big.slice(0, -1));
      if (n < INT64_MIN || n > INT64_MAX) this.fail("Out of the 64-bit integer range", start);
      return encodeInt64(n);
    }
    const num = this.match(NUMBER);
    if (num !== null) {
      if (/[A-Za-z_$0-9.]/.test(s[this.i] ?? "")) this.fail("Not a number", start);
      return Number(num);
    }
    const word = this.match(IDENT);
    if (word === null) this.fail(`Unexpected "${c}"`);
    switch (word) {
      case "true":
        return true;
      case "false":
        return false;
      case "null":
        return null;
      case "undefined":
        return UNSET;
      case "NaN":
      case "Infinity":
        return this.fail(`${word} cannot be stored: values are JSON numbers`, start);
      case "Bytes": {
        this.expect("(");
        this.skip();
        const b64 = this.string();
        this.expect(")");
        if (typeof b64 !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || b64.length % 4 !== 0)
          this.fail("Bytes(…) takes a base64 string", start);
        return { $bytes: b64 as string };
      }
      default:
        return this.fail(
          top
            ? `"${word}" is not a value: text needs quotes, like "${word}"`
            : `"${word}" is not a value: text needs quotes`,
          start,
        );
    }
  }

  string(): string {
    const s = this.s;
    const quote = s[this.i]!;
    const start = this.i++;
    let out = "";
    while (this.i < s.length && s[this.i] !== quote) {
      const ch = s[this.i]!;
      if (ch === "\n") this.fail("Unclosed text: a line break inside quotes", start);
      if (ch !== "\\") {
        out += ch;
        this.i++;
        continue;
      }
      const e = s[this.i + 1];
      const simple: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", "0": "\0" };
      if (e === "u") {
        const hex = s.slice(this.i + 2, this.i + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail("\\u needs four hex digits");
        out += String.fromCharCode(Number.parseInt(hex, 16));
        this.i += 6;
      } else if (e !== undefined && e in simple) {
        out += simple[e];
        this.i += 2;
      } else if (e !== undefined) {
        out += e; // \" \' \\ \/ and any other escaped character
        this.i += 2;
      } else this.i++;
    }
    if (this.i >= s.length) this.fail("Unclosed text", start);
    this.i++;
    return out;
  }

  object(): Value {
    this.i++; // {
    const out: Record<string, Value> = {};
    for (;;) {
      this.skip();
      if (this.s[this.i] === "}") {
        this.i++;
        return out;
      }
      const at = this.i;
      const c = this.s[this.i];
      const key =
        c === '"' || c === "'"
          ? this.string()
          : (this.match(IDENT) ?? this.fail(c === undefined ? 'Expected "}" before the end' : "Expected a field name"));
      if (key in out) this.fail(`"${key}" appears twice`, at);
      this.expect(":");
      const v = this.value();
      if (v !== UNSET) out[key] = v; // { a: undefined } is {}: the field is not there
      this.skip();
      if (this.s[this.i] === ",") this.i++;
      else if (this.s[this.i] !== "}")
        this.fail(this.i >= this.s.length ? 'Expected "}" before the end' : 'Expected "," or "}"');
    }
  }

  array(): Value {
    this.i++; // [
    const out: Value[] = [];
    for (;;) {
      this.skip();
      if (this.s[this.i] === "]") {
        this.i++;
        return out;
      }
      const at = this.i;
      const v = this.value();
      if (v === UNSET) this.fail("undefined cannot be in a list", at);
      out.push(v);
      this.skip();
      if (this.s[this.i] === ",") this.i++;
      else if (this.s[this.i] !== "]")
        this.fail(this.i >= this.s.length ? 'Expected "]" before the end' : 'Expected "," or "]"');
    }
  }
}

/** One value, and nothing after it. */
export function parseLiteral(text: string): ParseResult {
  const p = new Parser(text);
  try {
    p.skip();
    if (p.i >= text.length) return { ok: false, error: "Type a value", offset: 0 };
    const value = p.value(true);
    p.skip();
    if (p.i < text.length) p.fail("Unexpected text after the value");
    return { ok: true, value };
  } catch (e) {
    if (e instanceof Fail) return { ok: false, error: e.message, offset: e.offset };
    throw e;
  }
}

// ------------------------------------------------------------------ formatting

const KEY = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const key = (k: string) => (KEY.test(k) ? k : JSON.stringify(k));

/**
 * A value as a literal that parses back to it. Compact on one line (`{ a: 1, b: [2] }`), or with
 * `indent` spread over lines as a person would write it.
 */
export function formatLiteral(v: Literal, indent?: string, depth = 0): string {
  if (v === UNSET) return "undefined";
  switch (valueType(v)) {
    case "int64":
      return `${decodeInt64(v as { $integer: string })}n`;
    case "bytes":
      return `Bytes(${JSON.stringify((v as { $bytes: string }).$bytes)})`;
    case "array": {
      const items = (v as Value[]).map((x) => formatLiteral(x, indent, depth + 1));
      if (items.length === 0) return "[]";
      if (indent === undefined) return `[${items.join(", ")}]`;
      const pad = indent.repeat(depth + 1);
      return `[\n${items.map((x) => pad + x).join(",\n")},\n${indent.repeat(depth)}]`;
    }
    case "object": {
      const entries = Object.entries(v as Record<string, Value>).map(
        ([k, x]) => `${key(k)}: ${formatLiteral(x, indent, depth + 1)}`,
      );
      if (entries.length === 0) return "{}";
      if (indent === undefined) return `{ ${entries.join(", ")} }`;
      const pad = indent.repeat(depth + 1);
      return `{\n${entries.map((x) => pad + x).join(",\n")},\n${indent.repeat(depth)}}`;
    }
    default:
      return JSON.stringify(v);
  }
}
