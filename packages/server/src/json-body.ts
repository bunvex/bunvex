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

/**
 * A field of a body struct, as its Rust type deserializes:
 * - `string`, `optString` (`Option<String>`), `value` (any JSON value), `optValue` (any or no value, an `Option`
 *   or `#[serde(default)]` field whose type is not checked here), `strings` (`Vec<String>`), `stringMap`
 *   (`BTreeMap<String, String>`), a list of structs, a struct;
 * - `{ int }`: an integer type (`u64`, `u16`, `usize`, `i64`), with serde's range checks;
 * - `{ bool }`: a `bool`;
 * - `{ option }`: `Option<T>` (null or absent is `None`);
 * - `{ list }`: `Vec<T>`;
 * - `{ variants }`: a unit-only enum, from its (renamed) variant names;
 * - `{ default }`: a `#[serde(default)]` field (absent is allowed);
 * - `{ object }`: a nested struct whose contents are checked elsewhere (`expected struct <name>` otherwise).
 */
export type FieldKind =
  | "string"
  | "optString"
  | "value"
  | "optValue"
  | "strings"
  | "stringMap"
  | { seqOf: BodyShape }
  | { struct: BodyShape }
  | { int: IntType }
  | { bool: true }
  | { option: FieldKind }
  | { list: FieldKind }
  | { variants: readonly string[] }
  | { default: FieldKind }
  | { object: string };
type IntType = "u64" | "u16" | "usize" | "i64";
/**
 * A body struct: its Rust name (it is in serde's messages) and its fields in declaration order. `flatten`: the
 * struct has a `#[serde(flatten)]` field, so serde reads it as a map only (no positional, array form).
 */
export type BodyShape = {
  name: string;
  fields: [string, FieldKind][];
  flatten?: boolean;
  /**
   * An internally tagged enum (`#[serde(tag = "...")]`): its tag field and variant names. Only the tag is
   * checked here (the variant's own fields are checked by the route).
   */
  tagged?: { tag: string; variants: readonly string[] };
  /**
   * The function call routes' hot path: a body `JSON.parse` takes and whose shape fits is accepted without the
   * byte reader (a field given twice is then taken, where serde refuses it). Every other body is read as serde
   * reads it, duplicate fields included.
   */
  fast?: boolean;
};

const INT_RANGE: Record<IntType, [bigint, bigint]> = {
  u64: [0n, 2n ** 64n - 1n],
  usize: [0n, 2n ** 64n - 1n],
  u16: [0n, 65535n],
  i64: [-(2n ** 63n), 2n ** 63n - 1n],
};

/** Whether a field may be absent from the body (serde's `Option` and `#[serde(default)]`). */
const optional = (kind: FieldKind) =>
  kind === "optString" || kind === "optValue" || (typeof kind === "object" && ("option" in kind || "default" in kind));

export const UDF_POST: BodyShape = {
  fast: true,
  name: "UdfPostRequest",
  fields: [
    ["path", "string"],
    ["args", "value"],
    ["format", "optString"],
  ],
};
export const UDF_POST_WITH_TS: BodyShape = {
  fast: true,
  name: "UdfPostWithTsRequest",
  fields: [
    ["path", "string"],
    ["args", "value"],
    ["ts", "string"],
    ["format", "optString"],
  ],
};
export const UDF_POST_WITH_COMPONENT: BodyShape = {
  fast: true,
  name: "UdfPostRequestWithComponent",
  fields: [
    ["componentPath", "optString"],
    ["path", "string"],
    ["args", "value"],
    ["format", "optString"],
  ],
};

/** Convex's `RunTestFunctionArgs` (local_backend/src/dashboard.rs), its bundle a `ModuleJson`. */
export const RUN_TEST_FUNCTION: BodyShape = {
  fast: true,
  name: "RunTestFunctionArgs",
  fields: [
    ["adminKey", "string"],
    [
      "bundle",
      {
        struct: {
          name: "ModuleJson",
          fields: [
            ["path", "string"],
            ["source", "string"],
            ["sourceMap", "optString"],
            ["environment", "optString"],
          ],
        },
      },
    ],
    ["args", "value"],
    ["format", "string"],
    ["componentId", "optString"],
  ],
};

export const QUERY_BATCH: BodyShape = {
  name: "QueryBatchArgs",
  fast: true,
  fields: [["queries", { seqOf: UDF_POST }]],
};

export const UDF_POST_ARGS_ONLY: BodyShape = {
  fast: true,
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

/**
 * Check a body as Convex's extractor would (its content type, then `shape`), for a route that parses the body
 * itself afterwards (to keep integers past 2^53 exact, say). Throws `BadJsonBody`.
 */
export function checkJsonBody(req: Request, text: string, shape: BodyShape): void {
  if (!isJsonContentType(req.headers.get("content-type"))) throw new BadJsonBody(CONTENT_TYPE_ERROR);
  parseJsonBody(text, shape);
}

export function parseJsonBody<T>(text: string, shape: BodyShape): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (parsed !== undefined && fits(parsed, shape) && shape.fast) return parsed as T;
  // Read it again as serde_json does: its error, or — a struct written as an array, `[path, args, …]`,
  // which serde takes too — the fields by position.
  new Reader(text, shape).body();
  // Valid after all (an integer past 2^53, which `fits` leaves to the reader): the object as parsed.
  if (!Array.isArray(parsed)) return parsed as T;
  return Object.fromEntries(shape.fields.map(([name], k) => [name, (parsed as unknown[])[k]])) as T;
}

function fits(v: unknown, shape: BodyShape): boolean {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  if (shape.tagged) return shape.tagged.variants.includes((v as Record<string, unknown>)[shape.tagged.tag] as string);
  const o = v as Record<string, unknown>;
  for (const [name, kind] of shape.fields) if (!fitsField(o[name], kind)) return false;
  return true;
}

/** Whether a field's parsed value is what its kind takes (undefined: absent). */
function fitsField(x: unknown, kind: FieldKind): boolean {
  if (kind === "string") return typeof x === "string";
  if (kind === "optString") return x === undefined || x === null || typeof x === "string";
  if (kind === "value") return x !== undefined;
  if (kind === "optValue") return true;
  if (kind === "strings") return Array.isArray(x) && x.every((e) => typeof e === "string");
  if (kind === "stringMap")
    return (
      x !== null &&
      typeof x === "object" &&
      !Array.isArray(x) &&
      Object.values(x as object).every((e) => typeof e === "string")
    );
  if ("struct" in kind) return fits(x, kind.struct);
  if ("seqOf" in kind) return Array.isArray(x) && x.every((e) => fits(e, kind.seqOf));
  if ("int" in kind) {
    if (typeof x !== "number" || !Number.isInteger(x)) return false;
    const [lo, hi] = INT_RANGE[kind.int];
    return BigInt(x) >= lo && BigInt(x) <= hi && Number.isSafeInteger(x);
  }
  if ("bool" in kind) return typeof x === "boolean";
  if ("option" in kind) return x === undefined || x === null || fitsField(x, kind.option);
  if ("default" in kind) return x === undefined || fitsField(x, kind.default);
  if ("list" in kind) return Array.isArray(x) && x.every((e) => fitsField(e, kind.list));
  if ("variants" in kind) return typeof x === "string" && kind.variants.includes(x);
  return x !== null && typeof x === "object" && !Array.isArray(x); // { object }
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
    if (shape.tagged) return this.taggedEnum(shape.name, shape.tagged);
    if (b === 0x7b) return this.structFromMap(shape);
    if (b === 0x5b && !shape.flatten) return this.structFromSeq(shape);
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
      if (!seen.has(name) && !optional(kind)) throw this.error("data", `missing field \`${name}\``);
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
        // A `#[serde(default)]` field (and those after it) may be left out of the array.
        if (shape.fields.slice(k).every(([, kind]) => typeof kind === "object" && "default" in kind)) return;
        throw this.error(
          "data",
          `invalid length ${k}, expected struct ${shape.name} with ${n} element${n === 1 ? "" : "s"}`,
        );
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
    if (kind === "value" || kind === "optValue") return void this.value(0);
    if (kind === "stringMap") return void this.stringMap();
    if (kind === "strings") return void this.field({ list: "string" });
    if (typeof kind === "object" && "struct" in kind) return void this.struct(kind.struct);
    if (typeof kind === "object" && "default" in kind) return void this.field(kind.default);
    if (typeof kind === "object" && "option" in kind) {
      if (b === 0x6e) return void this.ident("null");
      return void this.field(kind.option);
    }
    if (typeof kind === "object" && "int" in kind) return void this.int(kind.int);
    if (typeof kind === "object" && "bool" in kind) {
      if (b === 0x74) return void this.ident("true");
      if (b === 0x66) return void this.ident("false");
      throw this.invalidType("a boolean");
    }
    if (typeof kind === "object" && "variants" in kind) return void this.variant(kind.variants);
    if (typeof kind === "object" && "object" in kind) {
      if (b === 0x7b || b === 0x5b) return void this.value(0);
      throw this.invalidType(`struct ${kind.object}`);
    }
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
        if ("list" in kind) this.field(kind.list);
        else this.struct(kind.seqOf);
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

  /**
   * An internally tagged enum, as serde reads one (its content buffered): a map with the tag naming a variant,
   * or a sequence whose first element does. Anything else is `invalid type`.
   */
  private taggedEnum(name: string, t: { tag: string; variants: readonly string[] }) {
    const b = this.peek()!;
    if (b === 0x5b) {
      this.i++;
      this.ws();
      if (this.peek() === 0x5d) {
        this.i++;
        throw this.error("data", `missing field \`${t.tag}\``);
      }
      this.path.push(t.tag);
      this.variant(t.variants);
      this.path.pop();
      // The variant's fields by position follow; the route checks them.
      for (;;) {
        this.ws();
        const c = this.peek();
        if (c === undefined) throw this.error("syntax", "EOF while parsing a list");
        if (c === 0x5d) {
          this.i++;
          return;
        }
        if (c !== 0x2c) throw this.peekError("syntax", "expected `,` or `]`");
        this.i++;
        this.ws();
        this.value(0);
      }
    }
    if (b !== 0x7b) throw this.invalidType(`internally tagged enum ${name}`);
    this.i++;
    let tagged = false;
    for (let k = 0; ; k++) {
      this.ws();
      let c = this.peek();
      if (c === undefined) throw this.error("syntax", "EOF while parsing an object");
      if (c === 0x7d) {
        this.i++;
        break;
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
      if (key === t.tag && !tagged) {
        if (this.peek() !== 0x22) throw this.invalidType("variant identifier");
        this.variant(t.variants);
        tagged = true;
      } else if (key === t.tag) throw this.error("data", `duplicate field \`${t.tag}\``);
      else this.value(0);
      this.path.pop();
    }
    if (!tagged) throw this.error("data", `missing field \`${t.tag}\``);
  }

  /** An integer field: serde's `invalid type` for anything else, `invalid value` outside the type's range. */
  private int(type: IntType) {
    const b = this.peek()!;
    if (b !== 0x2d && !isDigit(b)) throw this.invalidType(type);
    const what = this.number();
    if (what.startsWith("floating point")) throw this.error("data", `invalid type: ${what}, expected ${type}`);
    const n = BigInt(what.slice("integer `".length, -1));
    const [lo, hi] = INT_RANGE[type];
    if (n < lo || n > hi) throw this.error("data", `invalid value: ${what}, expected ${type}`);
  }

  /**
   * A unit-only enum (serde_json's `deserialize_enum`): a string naming a variant; serde's "unknown variant"
   * after the string, else "expected value" where the value starts.
   */
  private variant(variants: readonly string[]) {
    if (this.peek() !== 0x22) throw this.peekError("syntax", "expected value");
    const name = this.string();
    if (variants.includes(name)) return;
    const quoted = variants.map((v) => `\`${v}\``);
    const expected =
      quoted.length === 0
        ? "there are no variants"
        : quoted.length === 1
          ? quoted[0]
          : quoted.length === 2
            ? `${quoted[0]} or ${quoted[1]}`
            : `one of ${quoted.join(", ")}`;
    throw this.error("data", `unknown variant \`${name}\`, expected ${expected}`);
  }

  /** A `BTreeMap<String, String>`: an object whose values are strings (serde_path_to_error names the key). */
  private stringMap() {
    if (this.peek() !== 0x7b) throw this.invalidType("a map");
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
      this.field("string");
      this.path.pop();
    }
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
