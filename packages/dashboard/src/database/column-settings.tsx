// Each table's column layout — order, hidden columns, widths — kept in this browser (localStorage) per
// deployment scope and table (UI-01 §12.3), and the panel that edits it. Storage can be blocked (private
// windows, sandboxed frames): then the layout lasts for the page only.
import { Button } from "@bunvex/ui/components/button";
import { Checkbox } from "@bunvex/ui/components/checkbox";
import { type ColumnState, mergeColumnOrder, moveColumn } from "@bunvex/ui/lib/column-state";
import { ArrowDown, ArrowUp } from "lucide-react";
import { useCallback, useState } from "react";

const keyOf = (scope: string, table: string) => `bunvex-dashboard:${scope}:columns:${table}`;

function read(key: string): ColumnState {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? "{}");
    return typeof v === "object" && v !== null ? (v as ColumnState) : {};
  } catch {
    return {};
  }
}

export function useColumnState(scope: string, table: string): [ColumnState, (s: ColumnState) => void] {
  const key = keyOf(scope, table);
  const [state, setState] = useState<ColumnState>(() => read(key));
  const set = useCallback(
    (next: ColumnState) => {
      setState(next);
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {
        // kept for this page only
      }
    },
    [key],
  );
  return [state, set];
}

/** Show, hide and reorder the columns; widths are changed on the headers. */
export function ColumnSettings(props: { fields: string[]; state: ColumnState; onChange: (s: ColumnState) => void }) {
  const { state, onChange } = props;
  const order = mergeColumnOrder(state.order ?? [], props.fields);
  const hidden = new Set(state.hidden ?? []);
  const toggle = (field: string, show: boolean) =>
    onChange({ ...state, hidden: show ? [...hidden].filter((h) => h !== field) : [...hidden, field] });
  const move = (field: string, by: -1 | 1) => onChange({ ...state, order: moveColumn(order, field, by) });
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        Kept in this browser for this table. Resize a column from the edge of its header.
      </p>
      <ul className="divide-y border">
        {order.map((field, i) => (
          <li key={field} className="flex items-center gap-2 px-3 py-1.5">
            <Checkbox
              aria-label={`Show ${field}`}
              checked={!hidden.has(field)}
              onCheckedChange={(checked) => toggle(field, checked === true)}
            />
            <span className="min-w-0 flex-1 truncate font-mono text-xs">{field}</span>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`Move ${field} up`}
              disabled={i === 0}
              onClick={() => move(field, -1)}
            >
              <ArrowUp aria-hidden="true" />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`Move ${field} down`}
              disabled={i === order.length - 1}
              onClick={() => move(field, 1)}
            >
              <ArrowDown aria-hidden="true" />
            </Button>
          </li>
        ))}
      </ul>
      <Button variant="outline" size="sm" className="self-start" onClick={() => onChange({})}>
        Reset columns
      </Button>
    </div>
  );
}
