// A cell's context menu and shortcuts, as in Convex's data browser (STUDY-12 §1.4, D11): filter by the
// cell's value, copy it or the whole document, view or edit the document. The grid opens the menu on a
// right-click, Shift+F10, the Menu key or Ctrl/Cmd+Enter; the shortcuts work on the focused cell.
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@bunvex/ui/components/dropdown-menu";
import type { KeyboardEvent } from "react";
import type { Document, FieldFilter, FieldOp, FilterExpression, Value } from "../data-source.ts";
import { valueType } from "../filters.ts";
import { OP_LABEL } from "./filter-model.ts";
import { formatLiteral } from "./literal.ts";
import { formatTime } from "./values.ts";

export type CellActions = {
  /** Add a clause on this field to the applied filter. */
  filter: (clause: Omit<FieldFilter, "id" | "enabled">) => void;
  copy: (text: string, what: string) => void;
  viewDocument: () => void;
  /** Absent when the document cannot be replaced (read-only, or the source cannot). */
  editDocument?: () => void;
};

const MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = MAC ? "⌘" : "Ctrl+";

/** A value as the clipboard gets it: text as it is, anything else as a literal. */
export const clipboardText = (v: Value | undefined) =>
  v === undefined ? "undefined" : typeof v === "string" ? v : formatLiteral(v, "  ");

/** Which filters make sense on a value (Convex offers the same ones). */
export function filterOps(field: string, v: Value | undefined): FieldOp[] {
  if (v === undefined || v === null) return ["type", "notype"];
  const kind = valueType(v);
  const ordered = field !== "_id" && kind !== "object" && kind !== "array" && kind !== "boolean";
  return [
    ...(field === "_creationTime" ? [] : (["eq", "neq"] as FieldOp[])),
    ...(ordered ? (["gt", "gte", "lt", "lte"] as FieldOp[]) : []),
    ...(field.startsWith("_") ? [] : (["type", "notype"] as FieldOp[])),
  ];
}

/** The applied filter with one more clause (its id unused so far). */
export function withClause(expr: FilterExpression | null, clause: Omit<FieldFilter, "id" | "enabled">) {
  const base: FilterExpression = expr ?? { clauses: [], order: "desc" };
  const ids = new Set(base.clauses.map((c) => c.id));
  let n = base.clauses.length + 1;
  while (ids.has(`c${n}`)) n++;
  return { ...base, clauses: [...base.clauses, { ...clause, id: `c${n}`, enabled: true }] };
}

const shown = (field: string, v: Value) => {
  const text = field === "_creationTime" && typeof v === "number" ? formatTime(v) : formatLiteral(v);
  return text.length > 40 ? `${text.slice(0, 39)}…` : text;
};

export function CellMenuItems(props: {
  doc: Document;
  field: string;
  canEdit: boolean;
  edit: () => void;
  actions: CellActions;
}) {
  const { doc, field, actions } = props;
  const v = doc[field];
  const ops = filterOps(field, v);
  return (
    <>
      {ops.length > 0 && (
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            Filter by <code className="font-mono">{field}</code>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {ops.map((op) =>
              op === "type" || op === "notype" ? (
                <DropdownMenuItem key={op} onClick={() => actions.filter({ field, op, value: valueType(v) })}>
                  {OP_LABEL[op]} {valueType(v)}
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem key={op} onClick={() => actions.filter({ field, op, value: v as Value })}>
                  {OP_LABEL[op]} <code className="font-mono">{shown(field, v as Value)}</code>
                </DropdownMenuItem>
              ),
            )}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      )}
      <DropdownMenuItem aria-keyshortcuts="Control+C Meta+C" onClick={() => actions.copy(clipboardText(v), field)}>
        Copy <code className="font-mono">{field}</code>
        <DropdownMenuShortcut aria-hidden="true">{MOD}C</DropdownMenuShortcut>
      </DropdownMenuItem>
      <DropdownMenuItem aria-keyshortcuts="Enter" disabled={!props.canEdit} onClick={props.edit}>
        Edit <code className="font-mono">{field}</code>
        <DropdownMenuShortcut aria-hidden="true">Enter</DropdownMenuShortcut>
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem aria-keyshortcuts="Shift+Space" onClick={actions.viewDocument}>
        View document
        <DropdownMenuShortcut aria-hidden="true">⇧Space</DropdownMenuShortcut>
      </DropdownMenuItem>
      <DropdownMenuItem
        aria-keyshortcuts="Control+Shift+C Meta+Shift+C"
        onClick={() => actions.copy(formatLiteral(doc, "  "), "document")}
      >
        Copy document
        <DropdownMenuShortcut aria-hidden="true">⇧{MOD}C</DropdownMenuShortcut>
      </DropdownMenuItem>
      <DropdownMenuItem aria-keyshortcuts="Shift+Enter" disabled={!actions.editDocument} onClick={actions.editDocument}>
        Edit document
        <DropdownMenuShortcut aria-hidden="true">⇧Enter</DropdownMenuShortcut>
      </DropdownMenuItem>
    </>
  );
}

/** The shortcuts on a focused cell; true when the key was one of them. */
export function cellShortcut(e: KeyboardEvent<HTMLElement>, doc: Document, field: string, actions: CellActions) {
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  if (mod && key === "c" && !e.altKey) {
    if (window.getSelection()?.toString()) return false; // text selected by hand: the browser copies it
    if (e.shiftKey) actions.copy(formatLiteral(doc, "  "), "document");
    else actions.copy(clipboardText(doc[field]), field);
    return true;
  }
  if (e.key === " " && e.shiftKey && !mod) {
    actions.viewDocument();
    return true;
  }
  if (e.key === "Enter" && e.shiftKey && !mod && actions.editDocument) {
    actions.editDocument();
    return true;
  }
  return false;
}
