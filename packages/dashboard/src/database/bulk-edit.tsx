// Bulk edit (STUDY-149 "Bulk edit"), as Convex's `EditFieldsPanel.tsx`: the fields to set in the selected
// documents, or in every document of the table ("Edit all"), as a JavaScript literal — a field given `undefined` is
// removed. Applied in one call, all or nothing: the selected ones with the contract's patchDocuments, the whole
// table with patchAllDocuments (Convex's `patchDocumentsFields` without ids). The draft is kept per table while the
// page is open, as Add documents keeps its own, so closing the panel by mistake loses nothing.
import { Button } from "@bunvex/ui/components/button";
import { CodeEditor } from "@bunvex/ui/components/code-editor";
import { useId, useState } from "react";
import { useQueryScope } from "../context.tsx";
import { type FieldPatch, toDataSourceError } from "../data-source.ts";
import { formatCount } from "../screens/stats.ts";
import { parseFieldPatch } from "./literal.ts";

/** The documents a bulk edit changes: some by id, or every document of the table. */
export type BulkTarget = string[] | "all";

const drafts = new Map<string, string>();
const EMPTY = "{\n  \n}";

type Checked =
  | { ok: true; fields: Record<string, FieldPatch>; count: number }
  | { ok: false; error: string; offset?: number };

/** The editor's text as the contract's patch: each field set, or `{ $unset: true }` for an `undefined` one. */
export function checkFieldPatch(text: string): Checked {
  const r = parseFieldPatch(text);
  if (!r.ok) return r;
  const fields: Record<string, FieldPatch> = { ...r.set };
  for (const k of r.unset) fields[k] = { $unset: true };
  const system = Object.keys(fields).find((k) => k.startsWith("_"));
  if (system) return { ok: false, error: `"${system}" is a system field; it cannot be changed here.` };
  return { ok: true, fields, count: Object.keys(fields).length };
}

/** "all documents", "3 documents", "document": Convex's title words. */
export const bulkLabel = (target: BulkTarget) =>
  target === "all" ? "all documents" : target.length === 1 ? "document" : `${formatCount(target.length)} documents`;

export function BulkEdit(props: { table: string; target: BulkTarget; onApplied: (target: BulkTarget) => void }) {
  const { source } = useQueryScope();
  const { table, target } = props;
  const [text, setText] = useState(() => drafts.get(table) ?? EMPTY);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const hintId = useId();
  const checkId = useId();
  const errorId = useId();
  const check = checkFieldPatch(text);

  const apply = async () => {
    if (!check.ok || check.count === 0 || saving) return;
    setSaving(true);
    setError(undefined);
    try {
      if (target === "all") await source.patchAllDocuments!(table, check.fields);
      else await source.patchDocuments!(table, target, check.fields);
    } catch (e) {
      const failure = toDataSourceError(e);
      // Convex's dashboard shows a refusal the deployment explains as it is, and anything else after its advice
      setError(
        failure.code === "invalid_request" || failure.code === "not_found"
          ? failure.message
          : `Could not bulk edit documents. Try editing fewer documents or use a migration.\n\n${failure.message}`,
      );
      setSaving(false);
      return;
    }
    drafts.delete(table);
    props.onApplied(target);
  };

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        void apply();
      }}
    >
      <div id={hintId} className="text-sm text-muted-foreground">
        <p>You can:</p>
        <ul className="list-inside list-disc">
          <li>Add new fields</li>
          <li>Overwrite existing fields</li>
          <li>
            Remove existing fields by setting them to <code className="font-mono text-xs">undefined</code>
          </li>
        </ul>
      </div>
      <CodeEditor
        label="Fields to change"
        multiline
        height={280}
        autoFocus
        describedBy={`${hintId} ${checkId}${error ? ` ${errorId}` : ""}`}
        error={check.ok ? undefined : { message: check.error, offset: check.offset }}
        value={text}
        onChange={(t) => {
          setText(t);
          drafts.set(table, t);
          setError(undefined);
        }}
        onSubmit={() => void apply()}
      />
      {/* what is wrong with the draft, as you type; what the deployment refused, as an alert */}
      <p id={checkId} aria-live="polite" className="text-sm text-destructive empty:-mt-3">
        {!check.ok && check.error}
      </p>
      {error && (
        <p id={errorId} role="alert" className="text-sm whitespace-pre-line text-destructive">
          {error}
        </p>
      )}
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">Ctrl+Enter applies</span>
        <Button type="submit" disabled={saving || !check.ok || check.count === 0}>
          {saving ? "Applying…" : "Apply"}
        </Button>
      </div>
    </form>
  );
}
