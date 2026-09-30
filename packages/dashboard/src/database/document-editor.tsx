// Editing a whole document (UI-01 §12.5.7): its fields as a JavaScript literal in a code editor, saved with
// the contract's replaceDocument — `_id` and `_creationTime` stay (they are shown, not edited). As in
// Convex's document editor (STUDY-12 D9).
import { Button } from "@bunvex/ui/components/button";
import { CodeEditor } from "@bunvex/ui/components/code-editor";
import { useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { useQueryScope } from "../context.tsx";
import { dashboardKeys } from "../data/queries.ts";
import { type Document, toDataSourceError, type Value } from "../data-source.ts";
import { formatLiteral, parseLiteral, UNSET } from "./literal.ts";

/** The document's own fields: what an editor shows and a replace writes. */
const fieldsOf = (doc: Document) =>
  Object.fromEntries(Object.entries(doc).filter(([k]) => !k.startsWith("_"))) as Record<string, Value>;

type Check = { ok: true; fields: Record<string, Value> } | { ok: false; error: string; offset?: number };

export function checkDocument(text: string): Check {
  const r = parseLiteral(text);
  if (!r.ok) return r;
  const v = r.value;
  if (v === UNSET || typeof v !== "object" || v === null || Array.isArray(v) || "$integer" in v || "$bytes" in v)
    return { ok: false, error: "A document is an object: { field: value, … }", offset: 0 };
  const system = Object.keys(v).find((k) => k.startsWith("_"));
  if (system) return { ok: false, error: `"${system}" is a system field; it cannot be changed here.` };
  return { ok: true, fields: v as Record<string, Value> };
}

export function DocumentEditor(props: { table: string; doc: Document; onDone: (saved: boolean) => void }) {
  const { source, scope } = useQueryScope();
  const queryClient = useQueryClient();
  const [text, setText] = useState(() => formatLiteral(fieldsOf(props.doc), "  "));
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const hintId = useId();
  const checkId = useId();
  const check = checkDocument(text);

  const save = async () => {
    if (!check.ok) return;
    setSaving(true);
    setError(undefined);
    try {
      await source.replaceDocument!(props.table, props.doc._id, check.fields);
    } catch (e) {
      setSaving(false);
      return setError(toDataSourceError(e).message);
    }
    const next: Document = { ...check.fields, _id: props.doc._id, _creationTime: props.doc._creationTime };
    queryClient.setQueryData(dashboardKeys.document(scope, props.table, props.doc._id), next);
    void queryClient.invalidateQueries({ queryKey: [...dashboardKeys.all(scope), "documents", props.table] });
    props.onDone(true);
  };

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <p id={hintId} className="text-sm text-muted-foreground">
        Every field of the document; <code className="font-mono text-xs">_id</code> and{" "}
        <code className="font-mono text-xs">_creationTime</code> stay. A field left out is removed. Ctrl+Enter saves,
        Escape cancels.
      </p>
      <CodeEditor
        label={`Fields of ${props.doc._id}`}
        multiline
        height={360}
        autoFocus
        value={text}
        onChange={(t) => {
          setText(t);
          setError(undefined);
        }}
        error={check.ok ? undefined : { message: check.error, offset: check.offset }}
        describedBy={`${hintId} ${checkId}`}
        onSubmit={() => void save()}
        onCancel={() => props.onDone(false)}
      />
      <p id={checkId} aria-live="polite" className="min-h-5 text-sm text-destructive">
        {!check.ok && check.error}
      </p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={() => props.onDone(false)}>
          Cancel
        </Button>
        <Button type="submit" disabled={saving || !check.ok}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
  );
}
