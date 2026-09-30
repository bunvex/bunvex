// Adding documents (UI-01 §12.3): JavaScript literals, as in Convex (STUDY-12 D9) — one document, or a list
// of them — in a code editor, inserted all at once or not at all (the contract's insertDocuments). The draft is kept per table while the page is open, so closing
// the panel by mistake loses nothing.
import { Button } from "@bunvex/ui/components/button";
import { CodeEditor } from "@bunvex/ui/components/code-editor";
import { useId, useState } from "react";
import { useQueryScope } from "../context.tsx";
import { toDataSourceError, type Value } from "../data-source.ts";
import { parseLiteral, UNSET } from "./literal.ts";

const drafts = new Map<string, string>();
const EMPTY = "{\n  \n}";

type Parsed = { ok: true; documents: Record<string, Value>[] } | { ok: false; error: string; offset?: number };

/** One document or a list of them, as JavaScript literals; no system fields. */
export function parseDocuments(text: string): Parsed {
  const r = parseLiteral(text);
  if (!r.ok) return r;
  if (r.value === UNSET) return { ok: false, error: "Write a document { … } or a list of them [{ … }, …].", offset: 0 };
  const list = Array.isArray(r.value) ? r.value : [r.value];
  if (list.length === 0) return { ok: false, error: "The list is empty." };
  for (const [i, d] of list.entries()) {
    const which = list.length > 1 ? `Document ${i + 1}` : "The document";
    if (typeof d !== "object" || d === null || Array.isArray(d) || "$integer" in d || "$bytes" in d)
      return { ok: false, error: `${which} is not an object: write { field: value }.` };
    const system = Object.keys(d).find((k) => k.startsWith("_"));
    if (system) return { ok: false, error: `${which}: "${system}" is a system field; the database sets it.` };
  }
  return { ok: true, documents: list as Record<string, Value>[] };
}

export function AddDocuments({ table, onAdded }: { table: string; onAdded: (ids: string[]) => void }) {
  const { source } = useQueryScope();
  const [text, setText] = useState(() => drafts.get(table) ?? EMPTY);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const inputId = useId();
  const hintId = useId();
  const parsed = parseDocuments(text);
  const count = parsed.ok ? parsed.documents.length : 0;

  const submit = async () => {
    if (!parsed.ok) return setError(parsed.error);
    setSaving(true);
    setError(undefined);
    try {
      const ids = await source.insertDocuments!(table, parsed.documents);
      drafts.delete(table);
      onAdded(ids);
    } catch (e) {
      setError(toDataSourceError(e).message);
      setSaving(false);
    }
  };

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <p id={hintId} className="text-sm text-muted-foreground">
        One document <code className="font-mono text-xs">{'{ name: "Ada", n: 1 }'}</code> or a list{" "}
        <code className="font-mono text-xs">{"[{ … }, …]"}</code>. Text needs quotes;{" "}
        <code className="font-mono text-xs">10n</code> is a 64-bit integer.{" "}
        <code className="font-mono text-xs">_id</code> and <code className="font-mono text-xs">_creationTime</code> are
        set by the database. All are added, or none.
      </p>
      <CodeEditor
        label="Documents"
        multiline
        height={320}
        autoFocus
        describedBy={`${hintId} ${inputId}-check${error ? ` ${inputId}-error` : ""}`}
        error={parsed.ok ? undefined : { message: parsed.error, offset: parsed.offset }}
        value={text}
        onChange={(t) => {
          setText(t);
          drafts.set(table, t);
          setError(undefined);
        }}
        onSubmit={() => void submit()}
      />
      {/* what is wrong with the draft, as you type; what the source refused, as an alert */}
      <p id={`${inputId}-check`} aria-live="polite" className="min-h-5 text-sm text-destructive">
        {!parsed.ok && parsed.error}
      </p>
      {error && (
        <p id={`${inputId}-error`} role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">Ctrl+Enter adds</span>
        <Button type="submit" disabled={saving || count === 0}>
          {saving ? "Adding…" : count > 1 ? `Add ${count} documents` : "Add document"}
        </Button>
      </div>
    </form>
  );
}
