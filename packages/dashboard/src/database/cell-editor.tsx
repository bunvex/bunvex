// Editing one field of one document in place (UI-01 §12.3). The value is a JavaScript literal, as in Convex
// (STUDY-12 D9): `42`, `"text"`, `true`, `[1, 2]`, `{ a: 1 }`, `10n`; `undefined` or an empty box removes the
// field. A scalar is edited in the cell: Enter saves and stays, Tab saves and moves right. An object or a
// list opens a code editor under the cell: Ctrl/Cmd+Enter saves. Escape leaves it unchanged. A value that
// does not parse, or that the source refuses, keeps the editor open with the reason.
import { CodeEditor } from "@bunvex/ui/components/code-editor";
import type { EditOutcome } from "@bunvex/ui/components/data-table";
import { cn } from "@bunvex/ui/lib/utils";
import { type InfiniteData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useLayoutEffect, useRef, useState } from "react";
import { useQueryScope } from "../context.tsx";
import { dashboardKeys, schemaQuery } from "../data/queries.ts";
import { type Document, type FieldPatch, type Page, toDataSourceError, type Value } from "../data-source.ts";
import { valueType } from "../filters.ts";
import { formatLiteral, parseLiteral, parseLiteralLocated, UNSET } from "./literal.ts";
import {
  fieldSchema,
  issueDisplay,
  requiredFieldIssue,
  type SchemaIssue,
  schemaIssues,
  tableSchema,
} from "./schema-check.ts";

type CellEditorProps = { table: string; doc: Document; field: string; done: (outcome: EditOutcome) => void };

/**
 * Where a cell's text does not fit its field's declared type (`declared`, Convex's `validatorForColumn`): emptied
 * or `undefined` while the field is required, or a value of another type. A text that does not parse has none
 * (its own error comes on save).
 */
export function cellIssues(text: string, declared: ReturnType<typeof fieldSchema>): SchemaIssue[] {
  if (!declared) return [];
  if (text.trim() === "") return declared.optional ? [] : [requiredFieldIssue(declared.validator)];
  const r = parseLiteralLocated(text);
  if (!r.ok) return [];
  if (r.value === UNSET) return declared.optional ? [] : [requiredFieldIssue(declared.validator)];
  return schemaIssues(declared.validator, r.value, r.place);
}

/** A document with one field set, or removed. */
function patched(doc: Document, field: string, patch: FieldPatch): Document {
  const next = { ...doc };
  if (typeof patch === "object" && patch !== null && !Array.isArray(patch) && "$unset" in patch) delete next[field];
  else next[field] = patch as Value;
  return next;
}

export function CellEditor({ table, doc, field, done }: CellEditorProps) {
  const qs = useQueryScope();
  const { source, scope } = qs;
  const queryClient = useQueryClient();
  const { data: schema } = useQuery(schemaQuery(qs));
  const current = doc[field];
  const kind = valueType(current);
  const multiline = kind === "object" || kind === "array";
  const initial = current === undefined ? "" : formatLiteral(current, multiline ? "  " : undefined);
  const [text, setText] = useState(initial);
  const [error, setError] = useState<{ message: string; offset?: number }>();
  const [saving, setSaving] = useState(false);
  const errorId = useId();
  const hintId = useId();
  // the object editor is wider than its cell: near the grid's right edge it opens leftwards instead
  const popover = useRef<HTMLDivElement>(null);
  const [alignRight, setAlignRight] = useState(false);
  useLayoutEffect(() => {
    const el = popover.current;
    const grid = el?.closest('[data-slot="data-table"]');
    if (!el || !grid) return;
    setAlignRight(el.getBoundingClientRect().right > grid.getBoundingClientRect().right);
  }, []);

  // checked against the field's declared type as it is typed, as Convex's cell editor
  const declared = fieldSchema(tableSchema(schema, table), field);
  const shown = issueDisplay(cellIssues(text, declared), declared?.enforced ?? false);

  const save = async (outcome: "stay" | "right") => {
    if (text === initial) return done(outcome === "right" ? "right" : "cancel");
    if (shown.error) return setError(shown.error);
    let patch: FieldPatch;
    if (text.trim() === "") patch = { $unset: true };
    else {
      const parsed = parseLiteral(text);
      if (!parsed.ok) return setError({ message: parsed.error, offset: parsed.offset });
      patch = parsed.value === UNSET ? { $unset: true } : parsed.value;
    }
    setSaving(true);
    setError(undefined);
    try {
      await source.patchDocuments!(table, [doc._id], { [field]: patch });
    } catch (e) {
      setSaving(false);
      return setError({ message: toDataSourceError(e).message });
    }
    // show the new value now; the table's live refresh confirms it
    const all = dashboardKeys.all(scope);
    queryClient.setQueriesData<InfiniteData<Page<Document>>>({ queryKey: [...all, "documents", table] }, (old) =>
      old
        ? {
            ...old,
            pages: old.pages.map((p) => ({
              ...p,
              page: p.page.map((d) => (d._id === doc._id ? patched(d, field, patch) : d)),
            })),
          }
        : old,
    );
    queryClient.setQueryData<Document | null>(dashboardKeys.document(scope, table, doc._id), (old) =>
      old ? patched(old, field, patch) : old,
    );
    done(outcome);
  };

  const status = (error || saving) && (
    <p
      id={errorId}
      role={error ? "alert" : "status"}
      className={cn(
        "border bg-popover px-2 py-1 text-xs whitespace-normal shadow-sm",
        error ? "text-destructive" : "text-muted-foreground",
      )}
    >
      {error?.message ?? "Saving…"}
    </p>
  );
  const live = !error && !saving && (shown.error ?? shown.note) && (
    <p
      id={errorId}
      className={cn(
        "border bg-popover px-2 py-1 text-xs whitespace-normal shadow-sm",
        shown.error ? "text-destructive" : "text-warning",
      )}
    >
      {shown.error?.message ?? shown.note}
    </p>
  );
  const edit = {
    value: text,
    onChange: (t: string) => {
      setText(t);
      setError(undefined);
    },
    label: `Edit ${field}`,
    error: error ?? shown.error,
    moreErrors: error ? undefined : shown.moreErrors,
    warnings: error ? undefined : shown.warnings,
    describedBy: error || live ? `${errorId} ${hintId}` : hintId,
    autoFocus: true,
    onCancel: () => done("cancel"),
  };

  if (multiline)
    return (
      <div
        ref={popover}
        className={cn(
          "absolute top-0 z-30 flex w-[32rem] max-w-[80vw] flex-col gap-1 border-2 border-ring bg-background p-1 shadow-lg",
          alignRight ? "right-0" : "left-0",
        )}
      >
        <CodeEditor {...edit} multiline height={200} onSubmit={() => void save("stay")} />
        <span id={hintId} className="px-1 text-xs whitespace-normal text-muted-foreground">
          Ctrl+Enter saves, Escape cancels. <code className="font-mono">undefined</code> removes the field.
        </span>
        {status || live}
      </div>
    );

  return (
    <div className="absolute inset-y-0 left-0 z-20 min-w-full">
      <CodeEditor
        {...edit}
        className="h-full min-w-64 border-2 border-ring"
        onSubmit={() => void save("stay")}
        onTab={() => void save("right")}
      />
      <span id={hintId} className="sr-only">
        Enter saves, Tab saves and moves right, Escape cancels. Text needs quotes; an empty value or undefined removes
        the field.
      </span>
      {(status || live) && <div className="absolute top-full left-0 z-30 w-72">{status || live}</div>}
    </div>
  );
}
