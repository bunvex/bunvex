// Making the two backends' records comparable (STUDY-122 §3.1): ids, random by design, become `<table>#<n>`
// by first appearance; `_creationTime`, a clock, becomes its rank; an error keeps its kind and its message
// without the request id and the stack, which differ by design. Everything else is compared exactly.

/** One step of a run: what was asked and what came back. */
export type Step = {
  kind: "query" | "mutation" | "action";
  path: string;
  args: unknown;
  answer: { ok: boolean; status: number; body: unknown };
};

/** A backend's ids, in the order they appeared, and the table of each. */
export class IdMap {
  private names = new Map<string, string>();
  private counts = new Map<string, number>();
  /** Name an id the first time it is seen (its table from where it was inserted). */
  add(id: string, table: string) {
    if (this.names.has(id)) return;
    const n = (this.counts.get(table) ?? 0) + 1;
    this.counts.set(table, n);
    this.names.set(id, `${table}#${n}`);
  }
  name(id: string): string | undefined {
    return this.names.get(id);
  }
}

/** `v` with every known id named, every `_creationTime` replaced by its rank among `times`. */
export function normalize(v: unknown, ids: IdMap, times: number[]): unknown {
  if (typeof v === "string") return ids.name(v) ?? v;
  if (Array.isArray(v)) return v.map((x) => normalize(x, ids, times));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (k === "_creationTime" && typeof x === "number") out[k] = `t${times.indexOf(x)}`;
      // A page's cursors are opaque and differ by design (DV-73): whether there is one is what compares.
      else if ((k === "continueCursor" || k === "splitCursor") && typeof x === "string") out[k] = "<cursor>";
      // An error the app caught (a nested call's, a limit's): compared as an answer's error is.
      else if (k === "caught" && typeof x === "string") out[k] = errorText(x, ids);
      else out[k] = normalize(x, ids, times);
    }
    return out;
  }
  return v;
}

/** Every `_creationTime` in `v`, sorted: their ranks stand for them. */
export function creationTimes(v: unknown, into: Set<number> = new Set()): Set<number> {
  if (Array.isArray(v)) for (const x of v) creationTimes(x, into);
  else if (v && typeof v === "object")
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (k === "_creationTime" && typeof x === "number") into.add(x);
      else creationTimes(x, into);
    }
  return into;
}

/**
 * Convex's wording where bunvex words the same message its own way, per a decided divergence (DV-04: never
 * name Convex or link to its docs; docs/parity/divergences.md), applied to both sides. Each entry is a
 * difference of words only; the message's structure must still match.
 */
const WORDING: [RegExp, string][] = [
  // DV-04
  [/ To learn about Convex's supported types, see https:\/\/docs\.convex\.dev\/using\/types\./g, ""],
  [/ is not a valid Convex value/g, " is not a valid value"],
  // DV-04: the sentences that only point at Convex's docs.
  [/\n?For more information see https:\/\/docs\.convex\.dev\/\S*/g, ""],
  [/ See https:\/\/docs\.convex\.dev\/\S*( for (more )?details)?\.?/g, ""],
  // DV-03: the application error class is `BunvexError`, and its uncaught message names it so.
  [/\bConvexError\b/g, "BunvexError"],
];

/** A document id as it appears in a message: 31 to 37 characters of Crockford's base32, lower case. */
const ID_IN_TEXT = /\b[0-9a-hjkmnp-tv-z]{31,37}\b/g;

/** An error message without what differs by design: the request id prefix, the stack, Convex's wording. */
export function errorText(message: string, ids?: IdMap): string {
  let text = message;
  for (const [from, to] of WORDING) text = text.replace(from, to);
  // A document's display in a message (Convex's `must_validate`) holds its creation time, a clock.
  return text
    .replace(ID_IN_TEXT, (id) => ids?.name(id) ?? "<id>")
    .replace(/_creationTime: \d+(\.\d+)?/g, "_creationTime: <time>")
    .replace(/^\[Request ID: [^\]]+\] /, "")
    .split("\n")
    .filter((l) => !/^\s+at /.test(l))
    .join("\n")
    .trim();
}

/** An answer as the comparison sees it. */
export function answerShape(a: Step["answer"], ids: IdMap, times: number[]): unknown {
  const body = a.body as Record<string, unknown> | string;
  if (typeof body !== "object" || body === null) return { status: a.status, text: body };
  if (body.status === "success") return { ok: normalize(body.value, ids, times) };
  if (body.status === "error")
    return {
      error: errorText(String(body.errorMessage ?? ""), ids),
      ...(body.errorData === undefined ? {} : { data: normalize(body.errorData, ids, times) }),
    };
  return { status: a.status, code: body.code };
}
