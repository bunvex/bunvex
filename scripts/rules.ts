// The source scans of scripts/check-deps.ts, as functions its tests can call (scripts/rules.test.ts).

/**
 * The code of a TS/TSX source with its comments blanked out (strings, template literals and regex-free code
 * kept), so rule 5 sees identifiers, strings and URLs but not the comments that cite Convex.
 */
export function withoutComments(text: string): string {
  let out = "";
  let i = 0;
  let quote: string | null = null;
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (quote) {
      out += c;
      if (c === "\\") {
        out += next ?? "";
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i++;
    } else if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? text.length : end + 2;
      out += text.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
    } else {
      if (c === '"' || c === "'" || c === "`") quote = c;
      out += c;
      i++;
    }
  }
  return out;
}

/** Each `setTimeout(` / `setInterval(` call's delay (its second argument), its receiver (`this.engine.runtime.`), its line. */
export function* timerDelays(code: string): Generator<{ line: number; call: string; receiver: string; delay: string }> {
  const inString = stringMask(code);
  for (const m of code.matchAll(/((?:[\w$]+\??\.)*)\b(setTimeout|setInterval)\(/g)) {
    if (inString[m.index]) continue;
    const args: string[] = [""];
    let depth = 0;
    let quote: string | null = null;
    for (let i = m.index + m[0].length; i < code.length; i++) {
      const c = code[i]!;
      if (quote) {
        if (c === "\\") i++;
        else if (c === quote) quote = null;
        args[args.length - 1] += c;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") quote = c;
      else if ("([{".includes(c)) depth++;
      else if (")]}".includes(c)) {
        if (depth === 0) break;
        depth--;
      } else if (c === "," && depth === 0) {
        args.push("");
        continue;
      }
      args[args.length - 1] += c;
    }
    // One argument: no delay (0). Otherwise the delay is the second, the callback the first.
    const delay = args.length < 2 ? "0" : args[1]!.trim();
    yield { line: code.slice(0, m.index).split("\n").length, call: m[2]!, receiver: m[1]!, delay };
  }
}

/** A delay of number literals only (`1000`, `30 * 60 * 1000`, `2 ** 10`, `1_000`, `(1 + 2) * 3`): it is what it says. */
const LITERAL = /^[\d_.\s+\-*/()e]+$/;

/** The file's `const NAME = <number literals>` (a module constant), by name, with its value. */
export function literalConstants(code: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of code.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*(?::\s*number\s*)?=\s*([\d_.\s+\-*/()e]+?)\s*;/g)) {
    const v = evalLiteral(m[2]!);
    if (v !== null) out.set(m[1]!, v);
  }
  return out;
}

function evalLiteral(text: string): number | null {
  const t = text.trim();
  if (!LITERAL.test(t) || !/\d/.test(t)) return null;
  try {
    const v = Function(`"use strict"; return (${t.replaceAll("_", "")});`)() as unknown;
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

/** A delay whose value is known: number literals, or a module constant of them. */
function knownValue(d: string, consts: Map<string, number>): number | null {
  const t = d.trim();
  if (/^[A-Za-z_$][\w$]*$/.test(t)) return consts.get(t) ?? null;
  return evalLiteral(t);
}

/**
 * Rule 6: a timer's delay must be known not to pass 2^31−1 ms (Bun fires a longer one after about 1 ms). It is when
 * it is a number literal, a module constant of literals, `timerDelay(…)` (capped; the loop re-arms), or
 * `Math.min(…)` with such a bound among its arguments. Anything else (a knob's value, an option, a parameter, a
 * difference of clocks) may be longer: pass it through `timerDelay` where the loop looks again when woken, or use
 * core's `longTimeout` / `longInterval` / `longSleep`, which sleep any length.
 */
export function unsafeTimerDelay(delay: string, consts: Map<string, number> = new Map()): boolean {
  const d = delay.trim().replace(/\s+as\s+\w+$/, "");
  if (d === "") return false;
  // A declaration (`setTimeout(fn: () => void, ms: number)` in an interface), not a call.
  if (/^[A-Za-z_$][\w$]*\??\s*:\s*[A-Za-z]/.test(d)) return false;
  const known = knownValue(d, consts);
  if (known !== null) return known > 2 ** 31 - 1;
  if (/^timerDelay\(/.test(d)) return false;
  const min = d.match(/^Math\.min\(([\s\S]*)\)$/);
  if (min)
    return !splitTop(min[1]!).some((a) => {
      const v = knownValue(a, consts);
      return v !== null && v <= 2 ** 31 - 1;
    });
  return true;
}

/** `a, b, c` split at its top-level commas. */
function splitTop(s: string): string[] {
  const out = [""];
  let depth = 0;
  for (const c of s) {
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === "," && depth === 0) {
      out.push("");
      continue;
    }
    out[out.length - 1] += c;
  }
  return out;
}

/**
 * Whether rule 6 checks this call: not one on a core `Runtime` (`….runtime.setTimeout(`, `rt.setTimeout(`), whose
 * timers take any length (the real runtime's re-arm; a test runtime's time is virtual).
 */
export const checkedTimerCall = (receiver: string): boolean => !/(?:^|\.)(?:runtime|rt)\.$/.test(receiver);

/** Which characters of `code` are inside a string or template literal (a call written in a message is no call). */
function stringMask(code: string): Uint8Array {
  const mask = new Uint8Array(code.length);
  let quote: string | null = null;
  for (let i = 0; i < code.length; i++) {
    const c = code[i]!;
    if (quote) {
      mask[i] = 1;
      if (c === "\\") mask[++i] = 1;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === "`") {
      quote = c;
      mask[i] = 1;
    }
  }
  return mask;
}

/** The npm metadata a published package ships, which rule 5 checks as it checks the code. */
const METADATA_FIELDS = ["description", "keywords", "homepage", "repository", "bugs", "author"] as const;

/**
 * Rule 5 for a package.json: the metadata fields that name the upstream project. A private package is never
 * published, so it is not checked; names, dependencies and scripts are not metadata (a dev dependency on the
 * reference, for a test against it, is fine).
 */
export function metadataNaming(pkg: Record<string, unknown>): string[] {
  if (pkg.private === true) return [];
  return METADATA_FIELDS.filter((f) => pkg[f] !== undefined && /convex/i.test(JSON.stringify(pkg[f])));
}

/**
 * Rule 7: the lines of `code` (comments blanked) that declare a class field with `declare` (`declare readonly x: T`).
 * Babel's TypeScript transform refuses them unless `allowDeclareFields` is set, and Expo's Metro (React Native) reads
 * the workspace's sources through Babel; a type-only field is declared by merging an interface instead.
 */
export function* declareFields(code: string): Generator<{ line: number; text: string }> {
  const lines = code.split("\n");
  for (const [n, text] of lines.entries())
    if (
      /^\s*declare\s+(?:(?:private|protected|public|readonly|static|override)\s+)*[A-Za-z_$][\w$]*[?!]?\s*:/.test(text)
    )
      yield { line: n + 1, text: text.trim() };
}
