// The filter bar's model (UI-01 §12.3), pure: a draft the person edits — values as the text they typed —
// and the FilterExpression it applies once every enabled part is valid. The index rules (a prefix of the
// index's fields, then a range on the next one) are enforced here by only offering valid moves, so the
// bar never builds an expression the source would reject for its shape.
import type { FieldFilter, FieldOp, FilterExpression, IndexInfo, Value, ValueType } from "../data-source.ts";
import { DEFAULT_INDEX } from "../filters.ts";
import { formatValueInput, parseValueInput } from "./value-input.ts";

export type ClauseDraft = { id: string; field: string; op: FieldOp; text: string; enabled: boolean };
export type BoundDraft = { op: "gt" | "gte" | "lt" | "lte"; text: string };
export type FilterDraft = {
  index: string;
  /** One entry per leading index field fixed to a value, in index order. */
  eq: { text: string; enabled: boolean }[];
  range: { lower?: BoundDraft; upper?: BoundDraft };
  clauses: ClauseDraft[];
  order: "asc" | "desc";
};

export const OP_LABEL: Record<FieldOp, string> = {
  eq: "equals",
  neq: "is not",
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
  anyOf: "is any of",
  noneOf: "is none of",
  type: "is of type",
  notype: "is not of type",
};

/** What a clause's value box holds for an operator. */
export const valueKind = (op: FieldOp): "value" | "list" | "type" =>
  op === "anyOf" || op === "noneOf" ? "list" : op === "type" || op === "notype" ? "type" : "value";

export const indexFields = (ix: IndexInfo) => (ix.name === "by_id" ? ["_id"] : ix.fields);

export const emptyDraft = (): FilterDraft => ({ index: DEFAULT_INDEX, eq: [], range: {}, clauses: [], order: "desc" });

// ------------------------------------------------------------------ expression ↔ draft

const listText = (vs: Value[]) => vs.map(formatValueInput).join(", ");

export function toDraft(expr: FilterExpression | null): FilterDraft {
  if (!expr) return emptyDraft();
  const r = expr.index?.range;
  return {
    index: expr.index?.name ?? DEFAULT_INDEX,
    eq: (expr.index?.eq ?? []).map((c) => ({ text: formatValueInput(c.value), enabled: c.enabled })),
    range: {
      lower: r?.lower && { op: r.lower.op, text: formatValueInput(r.lower.value) },
      upper: r?.upper && { op: r.upper.op, text: formatValueInput(r.upper.value) },
    },
    clauses: expr.clauses.map((c) => ({
      id: c.id,
      field: c.field,
      op: c.op,
      enabled: c.enabled,
      text:
        c.value === undefined
          ? ""
          : valueKind(c.op) === "list"
            ? listText(c.value as Value[])
            : valueKind(c.op) === "type"
              ? (c.value as string)
              : formatValueInput(c.value as Value),
    })),
    order: expr.order,
  };
}

/** A list box: a JSON array, or values separated by commas. */
export function parseList(text: string): { ok: true; value: Value[] } | { ok: false; error: string } {
  const t = text.trim();
  if (t.startsWith("[")) {
    const p = parseValueInput(t);
    return p.ok && Array.isArray(p.value) ? { ok: true, value: p.value } : { ok: false, error: "Not a valid list" };
  }
  const parts = t === "" ? [] : t.split(",").map((s) => parseValueInput(s));
  if (parts.length === 0) return { ok: false, error: "Type one or more values, separated by commas" };
  const bad = parts.find((p) => !p.ok);
  if (bad && !bad.ok) return { ok: false, error: bad.error };
  return { ok: true, value: parts.map((p) => (p as { value: Value }).value) };
}

export type DraftErrors = Record<string, string>;

/**
 * The expression a draft applies, and what is wrong with it. Errors are keyed by clause id, `eq.<i>`,
 * `lower` or `upper`; a disabled clause with an error does not block the rest.
 */
export function fromDraft(d: FilterDraft): { expr: FilterExpression; errors: DraftErrors } {
  const errors: DraftErrors = {};
  const eq: NonNullable<FilterExpression["index"]>["eq"] = [];
  d.eq.forEach((c, i) => {
    const p = parseValueInput(c.text);
    if (p.ok) eq.push({ value: p.value, enabled: c.enabled });
    else if (c.enabled) errors[`eq.${i}`] = p.error;
    else eq.push({ value: null, enabled: false });
  });
  const bound = <O extends BoundDraft["op"]>(b: BoundDraft | undefined, key: string) => {
    if (!b || b.text.trim() === "") return undefined; // an empty bound is no bound
    const p = parseValueInput(b.text);
    if (!p.ok) {
      errors[key] = p.error;
      return undefined;
    }
    return { op: b.op as O, value: p.value };
  };
  const lower = bound<"gt" | "gte">(d.range.lower, "lower");
  const upper = bound<"lt" | "lte">(d.range.upper, "upper");
  const clauses: FieldFilter[] = [];
  for (const c of d.clauses) {
    const kind = valueKind(c.op);
    const parsed =
      kind === "list"
        ? parseList(c.text)
        : kind === "type"
          ? c.text
            ? { ok: true as const, value: c.text as ValueType }
            : { ok: false as const, error: "Pick a type" }
          : parseValueInput(c.text);
    if (!c.field) {
      if (c.enabled) errors[c.id] = "Pick a field";
      clauses.push({ id: c.id, field: c.field, op: c.op, enabled: false });
    } else if (parsed.ok) clauses.push({ id: c.id, field: c.field, op: c.op, value: parsed.value, enabled: c.enabled });
    else {
      if (c.enabled) errors[c.id] = parsed.error;
      clauses.push({ id: c.id, field: c.field, op: c.op, enabled: false });
    }
  }
  const expr: FilterExpression = { clauses, order: d.order };
  if (d.index !== DEFAULT_INDEX || eq.length > 0 || lower || upper) {
    expr.index = { name: d.index, eq };
    if (lower || upper) expr.index.range = { ...(lower && { lower }), ...(upper && { upper }) };
  }
  return { expr, errors };
}

// ------------------------------------------------------------------ valid moves

/** Switches the index; its clauses start over (they were about another index's fields). */
export const setIndex = (d: FilterDraft, index: string): FilterDraft => ({ ...d, index, eq: [], range: {} });

/** The index field the next equality would fix, if any is left (a range, if set, moves after it). */
export function nextEqField(d: FilterDraft, ix: IndexInfo): string | undefined {
  return indexFields(ix)[d.eq.length];
}

export const addEq = (d: FilterDraft, ix: IndexInfo): FilterDraft =>
  nextEqField(d, ix) === undefined ? d : { ...d, eq: [...d.eq, { text: "", enabled: true }], range: {} };

/** Opens the range on the field after the equalities, with both bounds empty (no bound yet). */
export const openRange = (d: FilterDraft): FilterDraft => ({
  ...d,
  range: { lower: { op: "gte", text: "" }, upper: { op: "lt", text: "" } },
});

/** Removing an equality removes the ones after it too: they must stay a prefix. */
export const removeEq = (d: FilterDraft, i: number): FilterDraft => ({ ...d, eq: d.eq.slice(0, i), range: {} });

/** The field a range bounds: the one right after the equalities. */
export const rangeField = (d: FilterDraft, ix: IndexInfo): string | undefined => indexFields(ix)[d.eq.length];

let seq = 0;
/** A clause id unique within the draft. */
export function newClauseId(d: FilterDraft): string {
  const taken = new Set(d.clauses.map((c) => c.id));
  let id: string;
  do id = `c${(++seq).toString(36)}`;
  while (taken.has(id));
  return id;
}

export const addClause = (d: FilterDraft, field = "", op: FieldOp = "eq", text = ""): FilterDraft => ({
  ...d,
  clauses: [...d.clauses, { id: newClauseId(d), field, op, text, enabled: true }],
});

export const updateClause = (d: FilterDraft, id: string, patch: Partial<ClauseDraft>): FilterDraft => ({
  ...d,
  clauses: d.clauses.map((c) => {
    if (c.id !== id) return c;
    const next = { ...c, ...patch };
    // a type box and a value box do not share their text
    if (patch.op && valueKind(patch.op) !== valueKind(c.op)) next.text = "";
    return next;
  }),
});

export const removeClause = (d: FilterDraft, id: string): FilterDraft => ({
  ...d,
  clauses: d.clauses.filter((c) => c.id !== id),
});

/** How many conditions are on: shown on the filter button. */
export const activeCount = (e: FilterExpression) =>
  e.clauses.filter((c) => c.enabled).length +
  (e.index?.eq.filter((c) => c.enabled).length ?? 0) +
  (e.index?.range ? 1 : 0);
