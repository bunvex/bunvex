// The filter bar (UI-01 §12.3): which index to read and which part of it (equalities on a prefix of its
// fields, then a range), the order, and conditions on any field. It edits a draft; once every enabled part
// is valid — for the model and for the table's indexes — the expression is applied (written to the URL)
// after a short pause, so typing does not fetch on every keystroke. A rejection from the source is shown
// against the clause it names.
import { Button } from "@bunvex/ui/components/button";
import { Checkbox } from "@bunvex/ui/components/checkbox";
import { CodeEditor } from "@bunvex/ui/components/code-editor";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@bunvex/ui/components/select";
import { cn } from "@bunvex/ui/lib/utils";
import { Plus, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  DataSourceError,
  FIELD_OPS,
  type FieldOp,
  type FilterExpression,
  type TableInfo,
  VALUE_TYPES,
} from "../data-source.ts";
import { DEFAULT_INDEX, validateFilter } from "../filters.ts";
import {
  addClause,
  addEq,
  type BoundDraft,
  type ClauseDraft,
  type DraftErrors,
  type FilterDraft,
  fromDraft,
  indexFields,
  nextEqField,
  OP_LABEL,
  openRange,
  rangeField,
  removeClause,
  removeEq,
  setIndex,
  toDraft,
  updateClause,
  valueKind,
} from "./filter-model.ts";
import { encodeFilter, isEmptyFilter } from "./filter-url.ts";
import { parseValueInput } from "./value-input.ts";

const APPLY_AFTER_MS = 350;

/** Where a value box's text stops parsing (for the editor's underline); a list box is read as `[…]`. */
function offsetOf(text: string, list = false): number | undefined {
  const t = list && !text.trim().startsWith("[") ? `[${text}]` : text;
  const r = parseValueInput(t);
  if (r.ok || r.offset === undefined) return undefined;
  return list && t !== text ? Math.max(0, r.offset - 1) : r.offset;
}

type FilterBarProps = {
  info: TableInfo;
  /** Fields seen in the loaded documents, for the field pickers. */
  fields: string[];
  /** The applied expression (from the URL) and its param. */
  applied: FilterExpression | null;
  appliedParam: string | undefined;
  onApply: (expr: FilterExpression, param: string | undefined) => void;
  /** What the source said about the applied expression, if it rejected it. */
  rejected?: DataSourceError;
};

export function FilterBar({ info, fields, applied, appliedParam, onApply, rejected }: FilterBarProps) {
  const [draft, setDraft] = useState<FilterDraft>(() => toDraft(applied));
  const lastParam = useRef(appliedParam);
  // the URL changed from elsewhere (back button, a link): start from it
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a change of the param resets the draft
  useEffect(() => {
    if (appliedParam !== lastParam.current) {
      lastParam.current = appliedParam;
      setDraft(toDraft(applied));
    }
  }, [appliedParam]);

  const { expr, errors } = useMemo(() => {
    const out = fromDraft(draft);
    const errs: DraftErrors = { ...out.errors };
    if (Object.keys(errs).length === 0)
      try {
        validateFilter(out.expr, info.indexes);
      } catch (e) {
        if (e instanceof DataSourceError) errs[e.details.clause ?? "index"] = e.message;
      }
    return { expr: out.expr, errors: errs };
  }, [draft, info.indexes]);
  const blocked = Object.keys(errors).length > 0;

  // biome-ignore lint/correctness/useExhaustiveDependencies: onApply is read at the time of applying
  useEffect(() => {
    if (blocked) return;
    const t = setTimeout(() => {
      const param = isEmptyFilter(expr) ? undefined : encodeFilter(expr);
      if (param === lastParam.current) return;
      lastParam.current = param;
      onApply(expr, param);
    }, APPLY_AFTER_MS);
    return () => clearTimeout(t);
  }, [expr, blocked]);

  const ix = info.indexes.find((i) => i.name === draft.index) ?? info.indexes[1]!;
  const eqFields = indexFields(ix);
  const next = nextEqField(draft, ix);
  const rangeOn = rangeField(draft, ix);
  const byTime = ix.name === DEFAULT_INDEX;
  const serverClause = rejected?.code === "invalid_request" ? (rejected.details.clause ?? "index") : undefined;
  const indexError = errors.index ?? (serverClause === "index" ? rejected?.message : undefined);
  const indexLabel = useId();
  const orderLabel = useId();
  const allFields = [...new Set([...fields, ...draft.clauses.map((c) => c.field).filter(Boolean)])];

  return (
    <section aria-label="Filters" className="flex flex-col gap-2 border bg-card p-3 text-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span id={indexLabel} className="text-muted-foreground">
          Index
        </span>
        <Select
          items={info.indexes.map((i) => ({ value: i.name, label: i.name }))}
          value={draft.index}
          onValueChange={(v) => setDraft((d) => setIndex(d, v as string))}
        >
          <SelectTrigger aria-labelledby={indexLabel} className="min-w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {info.indexes.map((i) => (
              <SelectItem key={i.name} value={i.name} disabled={i.state !== "ready"}>
                {i.name}
                {i.state !== "ready" && " (backfilling)"}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {draft.eq.map((c, i) => (
          <IndexEq
            // biome-ignore lint/suspicious/noArrayIndexKey: an equality is identified by its position in the index
            key={i}
            field={eqFields[i]!}
            text={c.text}
            error={errors[`eq.${i}`]}
            onText={(text) => setDraft((d) => ({ ...d, eq: d.eq.map((e, j) => (j === i ? { ...e, text } : e)) }))}
            onRemove={() => setDraft((d) => removeEq(d, i))}
          />
        ))}
        {/* nobody looks for one exact creation time: that index offers its range only */}
        {next !== undefined && !byTime && !draft.range.lower && !draft.range.upper && (
          <Button variant="outline" size="sm" onClick={() => setDraft((d) => addEq(d, ix))}>
            <Plus aria-hidden="true" />
            {next} =
          </Button>
        )}
        {rangeOn !== undefined &&
          (draft.range.lower || draft.range.upper ? (
            <Range
              field={rangeOn}
              lower={draft.range.lower}
              upper={draft.range.upper}
              errors={errors}
              onChange={(range) => setDraft((d) => ({ ...d, range }))}
            />
          ) : (
            <Button variant="outline" size="sm" onClick={() => setDraft(openRange)}>
              <Plus aria-hidden="true" />
              {rangeOn} range
            </Button>
          ))}
        <span className="ml-auto flex items-center gap-2">
          <span id={orderLabel} className="text-muted-foreground">
            Order
          </span>
          <Select
            items={[
              { value: "desc", label: byTime ? "Newest first" : "Descending" },
              { value: "asc", label: byTime ? "Oldest first" : "Ascending" },
            ]}
            value={draft.order}
            onValueChange={(v) => setDraft((d) => ({ ...d, order: v as "asc" | "desc" }))}
          >
            <SelectTrigger aria-labelledby={orderLabel} className="min-w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="desc">{byTime ? "Newest first" : "Descending"}</SelectItem>
              <SelectItem value="asc">{byTime ? "Oldest first" : "Ascending"}</SelectItem>
            </SelectContent>
          </Select>
        </span>
      </div>
      {indexError && (
        <p role="alert" className="text-destructive">
          {indexError}
        </p>
      )}
      {draft.clauses.length > 0 && (
        <ul className="flex flex-col gap-2">
          {draft.clauses.map((c) => (
            <Clause
              key={c.id}
              clause={c}
              fields={allFields}
              error={errors[c.id] ?? (serverClause === c.id ? rejected?.message : undefined)}
              onChange={(patch) => setDraft((d) => updateClause(d, c.id, patch))}
              onRemove={() => setDraft((d) => removeClause(d, c.id))}
            />
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => setDraft((d) => addClause(d))}>
          <Plus aria-hidden="true" />
          Add filter
        </Button>
        {(draft.clauses.length > 0 || draft.eq.length > 0 || draft.range.lower || draft.range.upper) && (
          <Button variant="ghost" size="sm" onClick={() => setDraft((d) => ({ ...d, eq: [], range: {}, clauses: [] }))}>
            Clear filters
          </Button>
        )}
        {rejected && rejected.code !== "invalid_request" && (
          <p role="alert" className="text-destructive">
            {rejected.message}
          </p>
        )}
      </div>
    </section>
  );
}

function IndexEq(props: {
  field: string;
  text: string;
  error?: string;
  onText: (t: string) => void;
  onRemove: () => void;
}) {
  const errorId = useId();
  return (
    <span className="flex items-center gap-1">
      <span className="font-mono text-xs">{props.field} =</span>
      <CodeEditor
        label={`${props.field} equals`}
        error={props.error ? { message: props.error, offset: offsetOf(props.text) } : undefined}
        describedBy={props.error ? errorId : undefined}
        className="w-40"
        value={props.text}
        onChange={props.onText}
      />
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={`Remove the ${props.field} condition`}
        onClick={props.onRemove}
      >
        <X aria-hidden="true" />
      </Button>
      {props.error && (
        <span id={errorId} className="text-xs text-destructive">
          {props.error}
        </span>
      )}
    </span>
  );
}

function Range(props: {
  field: string;
  lower?: BoundDraft;
  upper?: BoundDraft;
  errors: DraftErrors;
  onChange: (r: FilterDraft["range"]) => void;
}) {
  const { field, lower = { op: "gte", text: "" }, upper = { op: "lt", text: "" } } = props;
  const bound = (b: BoundDraft, side: "lower" | "upper") => {
    const ops = side === "lower" ? (["gt", "gte"] as const) : (["lt", "lte"] as const);
    const set = (patch: Partial<BoundDraft>) => props.onChange({ lower, upper, [side]: { ...b, ...patch } });
    return (
      <span className="flex items-center gap-1">
        <Select
          items={ops.map((o) => ({ value: o, label: OP_LABEL[o] }))}
          value={b.op}
          onValueChange={(v) => set({ op: v as BoundDraft["op"] })}
        >
          <SelectTrigger aria-label={`${field} ${side} bound operator`} className="h-7 w-14">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ops.map((o) => (
              <SelectItem key={o} value={o}>
                {OP_LABEL[o]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <CodeEditor
          label={`${field} ${side} bound`}
          error={props.errors[side] ? { message: props.errors[side]!, offset: offsetOf(b.text) } : undefined}
          placeholder="any"
          className="w-40"
          value={b.text}
          onChange={(text) => set({ text })}
        />
      </span>
    );
  };
  return (
    <span className="flex flex-wrap items-center gap-1">
      <span className="font-mono text-xs">{field}</span>
      {bound(lower, "lower")}
      <span className="text-muted-foreground">and</span>
      {bound(upper, "upper")}
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={`Remove the ${field} range`}
        onClick={() => props.onChange({})}
      >
        <X aria-hidden="true" />
      </Button>
      {(props.errors.lower || props.errors.upper) && (
        <span className="text-xs text-destructive">{props.errors.lower ?? props.errors.upper}</span>
      )}
    </span>
  );
}

function Clause(props: {
  clause: ClauseDraft;
  fields: string[];
  error?: string;
  onChange: (patch: Partial<ClauseDraft>) => void;
  onRemove: () => void;
}) {
  const { clause: c } = props;
  const errorId = useId();
  const name = c.field || "new filter";
  const kind = valueKind(c.op);
  return (
    <li className={cn("flex flex-wrap items-center gap-2", !c.enabled && "opacity-60")}>
      <Checkbox
        aria-label={`Apply the ${name} filter`}
        checked={c.enabled}
        onCheckedChange={(checked) => props.onChange({ enabled: checked === true })}
      />
      <Select
        items={props.fields.map((f) => ({ value: f, label: f }))}
        value={c.field || null}
        onValueChange={(v) => props.onChange({ field: v as string })}
      >
        <SelectTrigger aria-label="Field" className="h-7 min-w-36 font-mono text-xs">
          <SelectValue placeholder="Field" />
        </SelectTrigger>
        <SelectContent>
          {props.fields.map((f) => (
            <SelectItem key={f} value={f} className="font-mono text-xs">
              {f}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        items={FIELD_OPS.map((o) => ({ value: o, label: OP_LABEL[o] }))}
        value={c.op}
        onValueChange={(v) => props.onChange({ op: v as FieldOp })}
      >
        <SelectTrigger aria-label={`${name} operator`} className="h-7 min-w-32">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {FIELD_OPS.map((o) => (
            <SelectItem key={o} value={o}>
              {OP_LABEL[o]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {kind === "type" ? (
        <Select
          items={VALUE_TYPES.map((t) => ({ value: t, label: t }))}
          value={c.text || null}
          onValueChange={(v) => props.onChange({ text: v as string })}
        >
          <SelectTrigger aria-label={`${name} type`} className="h-7 min-w-28">
            <SelectValue placeholder="Type" />
          </SelectTrigger>
          <SelectContent>
            {VALUE_TYPES.map((t) => (
              <SelectItem key={t} value={t}>
                {t}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <CodeEditor
          label={`${name} value`}
          // "Pick a field" is not about the value: only the value's own mistakes mark it
          error={
            props.error && c.field ? { message: props.error, offset: offsetOf(c.text, kind === "list") } : undefined
          }
          describedBy={props.error ? errorId : undefined}
          placeholder={kind === "list" ? '"a", "b", 1' : '"text", 42, true…'}
          className="w-56"
          value={c.text}
          onChange={(text) => props.onChange({ text })}
        />
      )}
      <Button variant="ghost" size="icon-xs" aria-label={`Remove the ${name} filter`} onClick={props.onRemove}>
        <X aria-hidden="true" />
      </Button>
      {props.error && (
        <span id={errorId} className="text-xs text-destructive">
          {props.error}
        </span>
      )}
    </li>
  );
}
