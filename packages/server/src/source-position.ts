// Where a function is in the app's source (STUDY-65 M5): Convex's `AnalyzedSourcePosition`
// (crates/model/src/modules/module_versions.rs), computed as its analyze does (crates/isolate/src/environment/
// analyze.rs `udf_analyze` / `http_analyze`):
//
// - the handler's start in the bundled module, as V8 reports it (`get_script_line_number` /
//   `get_script_column_number`: an arrow function starts at its first character, any other function at its
//   parameter list's `(`);
// - Convex adds 1 to both (believing the source map lookup 1-based; it is 0-based), then takes the module's
//   source map token at or before that position, and reports the token's 0-based original line and column;
// - no position when the module has no source map, no token is found, or the handler is in another module
//   (a shared `_deps` chunk).
//
// JavaScriptCore does not tell where a function starts, so the handler is found by its text
// (`Function.prototype.toString`, the exact source) in the module. When the text occurs more than once, the
// occurrence after the declaration of the exported binding is taken; when that cannot be told, no position.

/** Convex's serialized `AnalyzedSourcePosition` (its fields are not camelCase there either). */
export type SourcePosition = { path: string; start_lineno: number; start_col: number };

/** A decoded mapping: generated line and column, original line and column (all 0-based). */
type Token = [genLine: number, genCol: number, srcLine: number, srcCol: number];
/** Decoded mappings, flat: four numbers per token (a `Token`), in generated order. */
type Tokens = Int32Array;

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
/** Each base64 digit's value by char code, -1 for other characters. */
const DIGIT = new Int8Array(128).fill(-1);
for (let i = 0; i < BASE64.length; i++) DIGIT[BASE64.charCodeAt(i)] = i;
const COMMA = 44;
const SEMICOLON = 59;

/** The tokens of a source map's `mappings` (version 3), in generated order; null if it does not parse. */
export function decodeMappings(mappings: string): Tokens | null {
  let out = new Int32Array(1024);
  let n = 0;
  let sorted = true;
  const fields = [0, 0, 0, 0, 0];
  let srcIndex = 0;
  let srcLine = 0;
  let srcCol = 0;
  let line = 0;
  let genCol = 0;
  let count = 0;
  let value = 0;
  let shift = 0;
  for (let i = 0; i <= mappings.length; i++) {
    const c = i === mappings.length ? SEMICOLON : mappings.charCodeAt(i);
    if (c === COMMA || c === SEMICOLON) {
      if (shift !== 0) return null; // a value cut short
      if (count !== 0) {
        if (count !== 1 && count !== 4 && count !== 5) return null;
        const col = genCol + fields[0]!;
        if (count >= 4) {
          srcIndex += fields[1]!;
          srcLine += fields[2]!;
          srcCol += fields[3]!;
          if (n + 4 > out.length) {
            const bigger = new Int32Array(out.length * 2);
            bigger.set(out);
            out = bigger;
          }
          if (n > 0 && out[n - 4] === line && out[n - 3]! > col) sorted = false;
          out[n++] = line;
          out[n++] = col;
          out[n++] = srcLine;
          out[n++] = srcCol;
        }
        genCol = col;
        count = 0;
      }
      if (c === SEMICOLON) {
        line++;
        genCol = 0;
      }
      continue;
    }
    const d = c < 128 ? DIGIT[c]! : -1;
    if (d === -1 || count === 5) return null;
    value += (d & 31) * 2 ** shift;
    shift += 5;
    if (d & 32) continue;
    fields[count++] = value % 2 === 1 ? -(value - 1) / 2 : value / 2;
    value = 0;
    shift = 0;
  }
  void srcIndex;
  out = out.slice(0, n);
  if (sorted) return out;
  // Not in generated order within a line (the format allows it): sort the tokens.
  const order = Array.from({ length: n / 4 }, (_, k) => k).sort(
    (a, b) => out[a * 4]! - out[b * 4]! || out[a * 4 + 1]! - out[b * 4 + 1]!,
  );
  const sortedOut = new Int32Array(n);
  for (const [j, k] of order.entries()) sortedOut.set(out.subarray(k * 4, k * 4 + 4), j * 4);
  return sortedOut;
}

/** The token at or before (`line`, `col`), 0-based, in generated order: the source map lookup Convex uses. */
export function lookupToken(tokens: Tokens, line: number, col: number): Token | null {
  let lo = 0;
  let hi = tokens.length / 4 - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const l = tokens[mid * 4]!;
    if (l < line || (l === line && tokens[mid * 4 + 1]! <= col)) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (found === -1) return null;
  const k = found * 4;
  return [tokens[k]!, tokens[k + 1]!, tokens[k + 2]!, tokens[k + 3]!];
}

/** Where V8 says a function starts, as an offset into its source text. */
export function functionStartOffset(text: string): number {
  // An arrow function: its first character (`async` included).
  if (/^(?:async\s*)?\(/.test(text) && !/^async\s*\([^)]*\)\s*\{/.test(text)) return 0;
  if (/^(?:async\s+)?[\w$]+\s*=>/.test(text)) return 0;
  // A function, generator or method: its parameter list.
  const p = text.indexOf("(");
  return p === -1 ? 0 : p;
}

/** The local names bound to `exported` by the module's export clauses and declarations. */
function localNames(source: string, exported: string): string[] {
  const names = new Set<string>();
  for (const clause of source.matchAll(/export\s*\{([^}]*)\}/g))
    for (const spec of clause[1]!.split(",")) {
      const m = /^\s*([\w$]+)(?:\s+as\s+([\w$]+))?\s*$/.exec(spec);
      if (m && (m[2] ?? m[1]) === exported) names.add(m[1]!);
    }
  if (exported !== "default") names.add(exported);
  return [...names];
}

const escapeName = (s: string) => s.replace(/[$]/g, "\\$");

/** The offset of `fn`'s source text in `source`, the module that exports it as `exported`; null if unsure. */
export function handlerOffset(source: string, fn: Function, exported: string | null): number | null {
  let text: string;
  try {
    text = Function.prototype.toString.call(fn);
  } catch {
    return null;
  }
  const at: number[] = [];
  for (let i = source.indexOf(text); i !== -1; i = source.indexOf(text, i + 1)) at.push(i);
  if (at.length === 0) return null;
  if (at.length === 1) return at[0]!;
  if (exported === null) return null;
  // Several functions with this text: the one in the exported binding's initializer.
  for (const local of localNames(source, exported)) {
    const decl = new RegExp(`(?:\\bvar|\\blet|\\bconst|,)\\s*${escapeName(local)}\\s*=`).exec(source);
    if (!decl) continue;
    const next = at.find((i) => i > decl.index);
    if (next !== undefined) return next;
  }
  return null;
}

/** A source map's tokens, decoded once per module. */
export class SourceMapTokens {
  private cache = new Map<string, Tokens | null>();
  constructor(private readonly maps: (path: string) => string | undefined) {}

  tokens(path: string): Tokens | null {
    if (!this.cache.has(path)) {
      const raw = this.maps(path);
      let t: Tokens | null = null;
      // Only `mappings` is read: parsing the whole map (its `sourcesContent`) would cost a push most of its
      // time here. A map whose `mappings` cannot be found or decoded gives no position, as an unparsable one.
      const mappings = raw === undefined ? null : /\x22mappings\x22\s*:\s*\x22([^\x22\\]*)\x22/.exec(raw);
      if (mappings && /"version"\s*:\s*3\b/.test(raw!)) t = decodeMappings(mappings[1]!);
      this.cache.set(path, t);
    }
    return this.cache.get(path)!;
  }

  /** `fn`'s position in module `path` (whose bundled source is `source`), as Convex's analyze reports it. */
  position(path: string, source: string, fn: unknown, exported: string | null): SourcePosition | null {
    if (typeof fn !== "function") return null;
    const tokens = this.tokens(path);
    if (!tokens) return null;
    const offset = handlerOffset(source, fn, exported);
    if (offset === null) return null;
    const start = offset + functionStartOffset(Function.prototype.toString.call(fn));
    let line = 0;
    for (let i = source.indexOf("\n"); i !== -1 && i < start; i = source.indexOf("\n", i + 1)) line++;
    const col = start - (source.lastIndexOf("\n", start - 1) + 1);
    // Convex's `lookup_token(lineno + 1, linecol + 1)` (see the top of this file).
    const t = lookupToken(tokens, line + 1, col + 1);
    return t ? { path, start_lineno: t[2], start_col: t[3] } : null;
  }
}

/** Convex's order of analyzed functions and routes: by position, those without one first (a stable sort). */
export function byPosition<T extends { pos: SourcePosition | null }>(items: T[]): T[] {
  return items.sort((a, b) => {
    if (!a.pos || !b.pos) return (a.pos ? 1 : 0) - (b.pos ? 1 : 0);
    if (a.pos.path !== b.pos.path) return a.pos.path < b.pos.path ? -1 : 1;
    return a.pos.start_lineno - b.pos.start_lineno || a.pos.start_col - b.pos.start_col;
  });
}
