// A JSON5 reader (STUDY-37 E8) for `bunvex run`'s arguments and `--identity`, as Convex's CLI reads them with
// the `json5` package: comments, trailing commas, unquoted keys, single-quoted strings, hex numbers, a
// leading or trailing decimal point, `+`, `Infinity` and `NaN`. The CLI has no dependencies, so it is ours.

export class Json5Error extends SyntaxError {
  override name = "SyntaxError";
}

const ID_START = /[A-Za-z_$]/;
const ID_PART = /[A-Za-z0-9_$]/;

export function parseJson5(text: string): unknown {
  let i = 0;
  const fail = (what: string): never => {
    if (i >= text.length && what.startsWith("invalid character")) what = "invalid end of input";
    const before = text.slice(0, i);
    const line = before.split("\n").length;
    const column = i - before.lastIndexOf("\n");
    throw new Json5Error(`JSON5: ${what} at ${line}:${column}`);
  };
  const ws = () => {
    for (;;) {
      if (/\s/.test(text[i] ?? "")) i++;
      else if (text.startsWith("//", i)) {
        while (i < text.length && text[i] !== "\n") i++;
      } else if (text.startsWith("/*", i)) {
        const end = text.indexOf("*/", i + 2);
        if (end === -1) fail("unterminated comment");
        i = end + 2;
      } else return;
    }
  };
  const string = (): string => {
    const q = text[i++]!;
    let out = "";
    for (;;) {
      const c = text[i++];
      if (c === undefined) fail("invalid end of input");
      if (c === q) return out;
      if (c === "\n") fail(`invalid character '\\n'`);
      if (c !== "\\") {
        out += c;
        continue;
      }
      const e = text[i++];
      const simple: Record<string, string> = { b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", 0: "\0" };
      if (e === undefined) fail("invalid end of input");
      if (e! in simple) out += simple[e!];
      else if (e === "x" || e === "u") {
        const n = e === "x" ? 2 : 4;
        const hex = text.slice(i, i + n);
        if (!new RegExp(`^[0-9a-fA-F]{${n}}$`).test(hex)) fail(`invalid escape`);
        out += String.fromCharCode(Number.parseInt(hex, 16));
        i += n;
      } else if (e === "\n") {
        // a line continuation
      } else out += e;
    }
  };
  const number = (): number => {
    const m = /^[+-]?(Infinity|NaN|0[xX][0-9a-fA-F]+|(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?)/.exec(text.slice(i));
    if (!m) return fail(`invalid character '${text[i]}'`);
    i += m[0].length;
    const sign = m[0].startsWith("-") ? -1 : 1;
    const body = m[0].replace(/^[+-]/, "");
    if (body === "Infinity") return sign * Number.POSITIVE_INFINITY;
    if (body === "NaN") return Number.NaN;
    return sign * (/^0[xX]/.test(body) ? Number.parseInt(body, 16) : Number(body));
  };
  const value = (): unknown => {
    ws();
    const c = text[i];
    if (c === undefined) return fail("invalid end of input");
    if (c === "{") {
      i++;
      const out: Record<string, unknown> = {};
      for (;;) {
        ws();
        if (text[i] === "}") {
          i++;
          return out;
        }
        let key: string;
        if (text[i] === '"' || text[i] === "'") key = string();
        else if (ID_START.test(text[i] ?? "")) {
          const start = i;
          while (ID_PART.test(text[i] ?? "")) i++;
          key = text.slice(start, i);
        } else return fail(`invalid character '${text[i] ?? ""}'`);
        ws();
        if (text[i++] !== ":") fail(`invalid character '${text[i - 1] ?? ""}'`);
        out[key] = value();
        ws();
        if (text[i] === ",") i++;
        else if (text[i] !== "}") fail(`invalid character '${text[i] ?? ""}'`);
      }
    }
    if (c === "[") {
      i++;
      const out: unknown[] = [];
      for (;;) {
        ws();
        if (text[i] === "]") {
          i++;
          return out;
        }
        out.push(value());
        ws();
        if (text[i] === ",") i++;
        else if (text[i] !== "]") fail(`invalid character '${text[i] ?? ""}'`);
      }
    }
    if (c === '"' || c === "'") return string();
    for (const [word, v] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ] as const)
      if (text.startsWith(word, i) && !ID_PART.test(text[i + word.length] ?? "")) {
        i += word.length;
        return v;
      }
    return number();
  };
  const v = value();
  ws();
  if (i < text.length) fail(`invalid character '${text[i]}'`);
  return v;
}
