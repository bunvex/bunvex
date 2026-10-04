// A request body as Convex's `Json` extractor reads it (`crates/common/src/http/extract.rs`; STUDY-67 H4):
// `Content-Type: application/json` (or `application/*+json`) required, then the body deserialized into the
// route's struct. Errors are 400 `BadJsonBody`, with axum's two prefixes — "Failed to parse the request body
// as JSON" for a syntax error, "Failed to deserialize the JSON body into the target type" for a body of the
// wrong shape — and serde_json's message, the field path (serde_path_to_error) and the line and column (in
// bytes) where the reader stopped.
//
// A body that `JSON.parse` takes and whose shape fits is accepted without a second look; only a failing body
// is read again, byte by byte, the way serde_json reads it, to say why and where.

export class BadJsonBody extends Error {
  readonly status = 400;
  readonly code = "BadJsonBody";
}

const CONTENT_TYPE_ERROR = "Expected request with `Content-Type: application/json`";

/** Convex's `json_content_type`: `application/json`, or `application/<anything>+json`, parameters allowed. */
export function isJsonContentType(header: string | null): boolean {
  if (header === null) return false;
  const essence = header.split(";")[0]!.trim().toLowerCase();
  const m = /^application\/([!#$%&'*+.^_`|~0-9a-z-]+)$/.exec(essence);
  return m !== null && (m[1] === "json" || m[1]!.endsWith("+json"));
}

/** A field of a body struct: a string, an optional string, any JSON value, or a list of structs. */
export type FieldKind = "string" | "optString" | "value" | { seqOf: BodyShape };
/** A body struct: its Rust name (it is in serde's messages) and its fields in declaration order. */
export type BodyShape = { name: string; fields: [string, FieldKind][] };

export const UDF_POST: BodyShape = {
  name: "UdfPostRequest",
  fields: [
    ["path", "string"],
    ["args", "value"],
    ["format", "optString"],
  ],
};
export const UDF_POST_WITH_TS: BodyShape = {
  name: "UdfPostWithTsRequest",
  fields: [
    ["path", "string"],
    ["args", "value"],
    ["ts", "string"],
    ["format", "optString"],
  ],
};
export const UDF_POST_WITH_COMPONENT: BodyShape = {
  name: "UdfPostRequestWithComponent",
  fields: [
    ["componentPath", "optString"],
    ["path", "string"],
    ["args", "value"],
    ["format", "optString"],
  ],
};

export const QUERY_BATCH: BodyShape = { name: "QueryBatchArgs", fields: [["queries", { seqOf: UDF_POST }]] };

export const UDF_POST_ARGS_ONLY: BodyShape = {
  name: "UdfPostRequestArgsOnly",
  fields: [
    ["args", "value"],
    ["format", "optString"],
  ],
};

/** The body of a request, checked as Convex checks it; a `BadJsonBody` when it is not one. */
export async function readJsonBody<T>(req: Request, text: () => Promise<string>, shape: BodyShape): Promise<T> {
  if (!isJsonContentType(req.headers.get("content-type"))) throw new BadJsonBody(CONTENT_TYPE_ERROR);
  return parseJsonBody<T>(await text(), shape);
}

export function parseJsonBody<T>(text: string, shape: BodyShape): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (parsed !== undefined && fits(parsed, shape)) return parsed as T;
  // Read it again as serde_json does: its error, or — a struct written as an array, `[path, args, …]`,
  // which serde takes too — the fields by position.
  new Reader(text, shape).body();
  return Object.fromEntries(shape.fields.map(([name], k) => [name, (parsed as unknown[])[k]])) as T;
}

function fits(v: unknown, shape: BodyShape): boolean {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  for (const [name, kind] of shape.fields) {
    const x = o[name];
    if (kind === "string" && typeof x !== "string") return false;
    if (kind === "optString" && x !== undefined && x !== null && typeof x !== "string") return false;
    if (kind === "value" && x === undefined) return false;
    if (typeof kind === "object" && (!Array.isArray(x) || !x.every((e) => fits(e, kind.seqOf)))) return false;
  }
  return true;
}

// ---------------------------------------------------------------- serde_json's reader, for the messages

class SerdeError extends Error {
  constructor(
    readonly kind: "syntax" | "data",
    message: string,
  ) {
    super(message);
  }
}

const isWs = (b: number) => b === 0x20 || b === 0x0a || b === 0x09 || b === 0x0d;
const isDigit = (b: number) => b >= 0x30 && b <= 0x39;

class Reader {
  private readonly bytes: Uint8Array;
  private i = 0;
  /** serde_path_to_error's path: `a.b`, `queries[0]`. */
  private readonly path: string[] = [];

  constructor(
    text: string,
    private readonly shape: BodyShape,
  ) {
    this.bytes = new TextEncoder().encode(text);
  }

  body(): void {
    try {
      this.ws();
      this.struct(this.shape);
      this.ws();
      if (this.i < this.bytes.length) throw this.peekError("syntax", "trailing characters");
    } catch (e) {
      if (!(e instanceof SerdeError)) throw e;
      const prefix =
        e.kind === "syntax"
          ? "Failed to parse the request body as JSON"
          : "Failed to deserialize the JSON body into the target type";
      throw new BadJsonBody(`${prefix}: ${e.message}`);
    }
  }

  // ---- positions: serde's line and column (bytes since the last newline)

  private position(upTo: number): string {
    let line = 1;
    let start = 0;
    for (let k = 0; k < upTo; k++)
      if (this.bytes[k] === 0x0a) {
        line++;
        start = k + 1;
      }
    return `at line ${line} column ${upTo - start}`;
  }
  private pathPrefix(): string {
    let s = "";
    for (const seg of this.path) s += seg.startsWith("[") || s === "" ? seg : `.${seg}`;
    return s === "" ? "" : `${s}: `;
  }
  /** An error where the reader stands (after what it consumed). */
  private error(kind: "syntax" | "data", msg: string): SerdeError {
    return new SerdeError(kind, `${this.pathPrefix()}${msg} ${this.position(this.i)}`);
  }
  /** An error at the byte the reader looked at but did not consume. */
  private peekError(kind: "syntax" | "data", msg: string): SerdeError {
    return new SerdeError(kind, `${this.pathPrefix()}${msg} ${this.position(Math.min(this.i + 1, this.bytes.length))}`);
  }

  private peek(): number | undefined {
    return this.bytes[this.i];
  }
  private ws() {
    while (this.i < this.bytes.length && isWs(this.bytes[this.i]!)) this.i++;
  }

  // ---- the target types

  private struct(shape: BodyShape) {
    const b = this.peek();
    if (b === undefined) throw this.error("syntax", "EOF while parsing a value");
    if (b === 0x7b) return this.structFromMap(shape);
    if (b === 0x5b) return this.structFromSeq(shape);
    throw this.invalidType(`struct ${shape.name}`);
  }

  private structFromMap(shape: BodyShape) {
    this.i++; // {
    const seen = new Set<string>();
    let first = true;
    for (;;) {
      this.ws();
      const b = this.peek();
      if (b === undefined) throw this.error("syntax", "EOF while parsing an object");
      if (b === 0x7d) {
        this.i++;
        break;
      }
      if (!first) {
        if (b !== 0x2c) throw this.peekError("syntax", "expected `,` or `}`");
        this.i++;
        this.ws();
        const c = this.peek();
        if (c === undefined) throw this.error("syntax", "EOF while parsing an object");
        if (c === 0x7d) throw this.peekError("syntax", "trailing comma");
      }
      first = false;
      if (this.peek() !== 0x22) throw this.peekError("syntax", "key must be a string");
      const key = this.string();
      const field = shape.fields.find(([n]) => n === key);
      if (field && seen.has(key)) throw this.error("data", `duplicate field \`${key}\``);
      this.ws();
      if (this.peek() === undefined) throw this.error("syntax", "EOF while parsing an object");
      if (this.peek() !== 0x3a) throw this.peekError("syntax", "expected `:`");
      this.i++;
      this.ws();
      this.path.push(key);
      this.field(field ? field[1] : "value");
      this.path.pop();
      if (field) seen.add(key);
    }
    for (const [name, kind] of shape.fields)
      if (!seen.has(name) && kind !== "optString") throw this.error("data", `missing field \`${name}\``);
  }

  private structFromSeq(shape: BodyShape) {
    this.i++; // [
    const n = shape.fields.length;
    for (let k = 0; k < n; k++) {
      this.ws();
      let b = this.peek();
      if (b === undefined) throw this.error("syntax", "EOF while parsing a list");
      if (k > 0 && b !== 0x5d) {
        if (b !== 0x2c) throw this.peekError("syntax", "expected `,` or `]`");
        this.i++;
        this.ws();
        b = this.peek();
        if (b === undefined) throw this.error("syntax", "EOF while parsing a list");
        if (b === 0x5d) throw this.peekError("syntax", "trailing comma");
      }
      if (b === 0x5d) {
        this.i++;
        throw this.error("data", `invalid length ${k}, expected struct ${shape.name} with ${n} elements`);
      }
      this.path.push(`[${k}]`);
      this.field(shape.fields[k]![1]);
      this.path.pop();
    }
    this.ws();
    if (this.peek() === undefined) throw this.error("syntax", "EOF while parsing a list");
    if (this.peek() !== 0x5d) throw this.peekError("syntax", "trailing characters");
    this.i++;
  }

  private field(kind: FieldKind) {
    const b = this.peek();
    if (b === undefined) throw this.error("syntax", "EOF while parsing a value");
    if (kind === "value") return this.value(0);
    if (typeof kind === "object") {
      if (b !== 0x5b) throw this.invalidType("a sequence");
      this.i++;
      for (let k = 0; ; k++) {
        this.ws();
        let c = this.peek();
        if (c === undefined) throw this.error("syntax", "EOF while parsing a list");
        if (c === 0x5d) {
          this.i++;
          return;
        }
        if (k > 0) {
          if (c !== 0x2c) throw this.peekError("syntax", "expected `,` or `]`");
          this.i++;
          this.ws();
          c = this.peek();
          if (c === undefined) throw this.error("syntax", "EOF while parsing a list");
          if (c === 0x5d) throw this.peekError("syntax", "trailing comma");
        }
        this.path.push(`[${k}]`);
        this.struct(kind.seqOf);
        this.path.pop();
      }
    }
    if (b === 0x22) {
      this.string();
      return;
    }
    if (kind === "optString" && b === 0x6e) {
      this.ident("null");
      return;
    }
    throw this.invalidType("a string");
  }

  /** serde_json's `peek_invalid_type`: a scalar is read first (the error stands after it), `[` and `{` not. */
  private invalidType(expected: string): SerdeError {
    const b = this.peek()!;
    let what: string;
    if (b === 0x6e) {
      this.ident("null");
      what = "null";
    } else if (b === 0x74) {
      this.ident("true");
      what = "boolean `true`";
    } else if (b === 0x66) {
      this.ident("false");
      what = "boolean `false`";
    } else if (b === 0x2d || isDigit(b)) what = this.number();
    else if (b === 0x22) what = `string ${JSON.stringify(this.string())}`;
    else if (b === 0x5b) what = "sequence";
    else if (b === 0x7b) what = "map";
    else throw this.peekError("syntax", "expected value");
    return this.error("data", `invalid type: ${what}, expected ${expected}`);
  }

  // ---- JSON values

  private value(depth: number): void {
    const b = this.peek();
    if (b === undefined) throw this.error("syntax", "EOF while parsing a value");
    if (depth >= 128 && (b === 0x5b || b === 0x7b)) {
      this.i++;
      throw this.error("syntax", "recursion limit exceeded");
    }
    if (b === 0x6e) return void this.ident("null");
    if (b === 0x74) return void this.ident("true");
    if (b === 0x66) return void this.ident("false");
    if (b === 0x2d || isDigit(b)) return void this.number();
    if (b === 0x22) return void this.string();
    if (b === 0x5b) {
      this.i++;
      for (let k = 0; ; k++) {
        this.ws();
        let c = this.peek();
        if (c === undefined) throw this.error("syntax", "EOF while parsing a list");
        if (c === 0x5d) {
          this.i++;
          return;
        }
        if (k > 0) {
          if (c !== 0x2c) throw this.peekError("syntax", "expected `,` or `]`");
          this.i++;
          this.ws();
          c = this.peek();
          if (c === undefined) throw this.error("syntax", "EOF while parsing a list");
          if (c === 0x5d) throw this.peekError("syntax", "trailing comma");
        }
        this.path.push(`[${k}]`);
        this.value(depth + 1);
        this.path.pop();
      }
    }
    if (b === 0x7b) {
      this.i++;
      for (let k = 0; ; k++) {
        this.ws();
        let c = this.peek();
        if (c === undefined) throw this.error("syntax", "EOF while parsing an object");
        if (c === 0x7d) {
          this.i++;
          return;
        }
        if (k > 0) {
          if (c !== 0x2c) throw this.peekError("syntax", "expected `,` or `}`");
          this.i++;
          this.ws();
          c = this.peek();
          if (c === undefined) throw this.error("syntax", "EOF while parsing an object");
          if (c === 0x7d) throw this.peekError("syntax", "trailing comma");
        }
        if (this.peek() !== 0x22) throw this.peekError("syntax", "key must be a string");
        const key = this.string();
        this.ws();
        if (this.peek() === undefined) throw this.error("syntax", "EOF while parsing an object");
        if (this.peek() !== 0x3a) throw this.peekError("syntax", "expected `:`");
        this.i++;
        this.ws();
        this.path.push(key);
        this.value(depth + 1);
        this.path.pop();
      }
    }
    throw this.peekError("syntax", "expected value");
  }

  private ident(word: string) {
    this.i++; // the first letter, already seen
    for (let k = 1; k < word.length; k++) {
      const b = this.bytes[this.i];
      if (b === undefined) throw this.error("syntax", "EOF while parsing a value");
      this.i++;
      if (b !== word.charCodeAt(k)) throw this.error("syntax", "expected ident");
    }
  }

  /** A number, read as serde_json reads it; its description for an `invalid type` message. */
  private number(): string {
    const start = this.i;
    if (this.peek() === 0x2d) this.i++;
    const first = this.peek();
    if (first === undefined) throw this.error("syntax", "EOF while parsing a value");
    if (!isDigit(first)) throw this.peekError("syntax", "invalid number");
    this.i++;
    if (first === 0x30) {
      if (this.peek() !== undefined && isDigit(this.peek()!)) throw this.peekError("syntax", "invalid number");
    } else while (this.peek() !== undefined && isDigit(this.peek()!)) this.i++;
    let float = false;
    if (this.peek() === 0x2e) {
      float = true;
      this.i++;
      if (this.peek() === undefined) throw this.error("syntax", "EOF while parsing a value");
      if (!isDigit(this.peek()!)) throw this.peekError("syntax", "invalid number");
      while (this.peek() !== undefined && isDigit(this.peek()!)) this.i++;
    }
    if (this.peek() === 0x65 || this.peek() === 0x45) {
      float = true;
      this.i++;
      if (this.peek() === 0x2b || this.peek() === 0x2d) this.i++;
      if (this.peek() === undefined) throw this.error("syntax", "EOF while parsing a value");
      if (!isDigit(this.peek()!)) throw this.peekError("syntax", "invalid number");
      while (this.peek() !== undefined && isDigit(this.peek()!)) this.i++;
    }
    const text = new TextDecoder().decode(this.bytes.subarray(start, this.i));
    if (!float) {
      const n = BigInt(text);
      if (n >= -(2n ** 63n) && n < 2n ** 64n) return `integer \`${n}\``;
    }
    const f = Number(text);
    if (!Number.isFinite(f)) throw this.error("syntax", "number out of range");
    return `floating point \`${floatText(f)}\``;
  }

  /** A string's contents; serde_json's escape and control-character rules. */
  private string(): string {
    this.i++; // "
    let out = "";
    let run = this.i;
    const flush = () => {
      out += new TextDecoder().decode(this.bytes.subarray(run, this.i));
    };
    for (;;) {
      const b = this.bytes[this.i];
      if (b === undefined) throw this.error("syntax", "EOF while parsing a string");
      if (b === 0x22) {
        flush();
        this.i++;
        return out;
      }
      if (b < 0x20) {
        this.i++;
        throw this.error("syntax", "control character (\\u0000-\\u001F) found while parsing a string");
      }
      if (b !== 0x5c) {
        this.i++;
        continue;
      }
      flush();
      this.i++;
      const e = this.bytes[this.i];
      if (e === undefined) throw this.error("syntax", "EOF while parsing a string");
      this.i++;
      const simple: Record<number, string> = {
        34: '"',
        92: "\\",
        47: "/",
        98: "\b",
        102: "\f",
        110: "\n",
        114: "\r",
        116: "\t",
      };
      if (e in simple) out += simple[e];
      else if (e === 0x75) {
        const hi = this.hex4();
        if (hi >= 0xdc00 && hi <= 0xdfff) throw this.error("syntax", "lone leading surrogate in hex escape");
        if (hi >= 0xd800 && hi <= 0xdbff) {
          for (const want of [0x5c, 0x75]) {
            const c = this.bytes[this.i];
            if (c === undefined) throw this.error("syntax", "EOF while parsing a string");
            this.i++;
            if (c !== want) throw this.error("syntax", "unexpected end of hex escape");
          }
          const lo = this.hex4();
          if (lo < 0xdc00 || lo > 0xdfff) throw this.error("syntax", "lone leading surrogate in hex escape");
          out += String.fromCharCode(hi, lo);
        } else out += String.fromCharCode(hi);
      } else throw this.error("syntax", "invalid escape");
      run = this.i;
    }
  }

  private hex4(): number {
    let n = 0;
    for (let k = 0; k < 4; k++) {
      const b = this.bytes[this.i];
      if (b === undefined) throw this.error("syntax", "EOF while parsing a string");
      this.i++;
      const d =
        b >= 0x30 && b <= 0x39 ? b - 0x30 : b >= 0x61 && b <= 0x66 ? b - 0x57 : b >= 0x41 && b <= 0x46 ? b - 0x37 : -1;
      if (d < 0) {
        // serde reads all four before it complains
        this.i += 3 - k;
        this.i = Math.min(this.i, this.bytes.length);
        throw this.error("syntax", "invalid escape");
      }
      n = n * 16 + d;
    }
    return n;
  }
}

/** A float as serde's `invalid type` message shows it: `1.5`, `1.0`, `1.8446744073709552e+19`. */
function floatText(f: number): string {
  const s = String(f);
  if (/e/.test(s)) return s;
  if (Math.abs(f) >= 1e16) return f.toExponential().replace(/e\+?/, "e+").replace("e+-", "e-");
  return Number.isInteger(f) ? `${s}.0` : s;
}
