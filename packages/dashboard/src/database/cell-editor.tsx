// Editing one field of one document in place (UI-01 §12.3): the value in the same syntax as the filter
// bar (`42`, `true`, `"text"`, `[1, 2]`, `42n`), an empty box removes the field. Enter saves and stays on the
// cell, Tab saves and moves right, Escape leaves it unchanged. A value that does not parse, or that the
// source refuses, keeps the editor open with the reason.
import type { EditOutcome } from "@bunvex/ui/components/data-table";
import { cn } from "@bunvex/ui/lib/utils";
import { type InfiniteData, useQueryClient } from "@tanstack/react-query";
import { type KeyboardEvent, useId, useState } from "react";
import { useQueryScope } from "../context.tsx";
import { dashboardKeys } from "../data/queries.ts";
import { type Document, type FieldPatch, type Page, toDataSourceError, type Value } from "../data-source.ts";
import { formatValueInput, parseValueInput } from "./value-input.ts";

type CellEditorProps = { table: string; doc: Document; field: string; done: (outcome: EditOutcome) => void };

/** A document with one field set, or removed. */
function patched(doc: Document, field: string, patch: FieldPatch): Document {
  const next = { ...doc };
  if (typeof patch === "object" && patch !== null && !Array.isArray(patch) && "$unset" in patch) delete next[field];
  else next[field] = patch as Value;
  return next;
}

export function CellEditor({ table, doc, field, done }: CellEditorProps) {
  const { source, scope } = useQueryScope();
  const queryClient = useQueryClient();
  const current = doc[field];
  const initial = current === undefined ? "" : formatValueInput(current);
  const [text, setText] = useState(initial);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const errorId = useId();
  const hintId = useId();

  const save = async (outcome: "stay" | "right") => {
    if (text === initial) return done(outcome === "right" ? "right" : "cancel");
    let patch: FieldPatch;
    if (text.trim() === "") patch = { $unset: true };
    else {
      const parsed = parseValueInput(text);
      if (!parsed.ok) return setError(parsed.error);
      patch = parsed.value;
    }
    setSaving(true);
    setError(undefined);
    try {
      await source.patchDocuments!(table, [doc._id], { [field]: patch });
    } catch (e) {
      setSaving(false);
      return setError(toDataSourceError(e).message);
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

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void save("stay");
    } else if (e.key === "Tab" && !e.shiftKey) {
      e.preventDefault();
      void save("right");
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation(); // not the side panel's Escape
      done("cancel");
    }
  };

  return (
    <div className="absolute inset-y-0 left-0 z-20 min-w-full">
      <input
        aria-label={`Edit ${field}`}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${errorId} ${hintId}` : hintId}
        // biome-ignore lint/a11y/noAutofocus: the editor opens on Enter and takes the focus, as in a spreadsheet
        autoFocus
        readOnly={saving}
        className={cn(
          "h-full w-full min-w-64 border-2 border-ring bg-background px-2.5 font-mono text-xs outline-none",
          error && "border-destructive",
        )}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setError(undefined);
        }}
        onKeyDown={onKeyDown}
      />
      <span id={hintId} className="sr-only">
        Enter saves, Tab saves and moves right, Escape cancels. An empty value removes the field.
      </span>
      {(error || saving) && (
        <p
          id={errorId}
          role={error ? "alert" : "status"}
          className={cn(
            "absolute top-full left-0 z-30 w-72 border bg-popover px-2 py-1 text-xs whitespace-normal shadow-sm",
            error ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {error ?? "Saving…"}
        </p>
      )}
    </div>
  );
}
