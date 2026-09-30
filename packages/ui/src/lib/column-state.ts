// A table's column layout as the user left it — order, hidden columns, widths — and the rules for applying
// it to the columns a table has now. Pure: persisted by the caller (the dashboard keeps one per table).

export type ColumnState = {
  /** Column ids in the order the user put them; ids the table no longer has are ignored. */
  order?: string[];
  hidden?: string[];
  /** px; a column without an entry has the default width. */
  widths?: Record<string, number>;
};

export const MIN_WIDTH = 60;
export const MAX_WIDTH = 800;
export const clampWidth = (w: number) => Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, w)));

/**
 * The saved order applied to the columns there are now. A column the saved order does not know (a field
 * that just appeared) goes right after its natural predecessor — so a new field lands near where it would
 * have been, and a column that is naturally last (like `_creationTime`) stays after it.
 */
export function mergeColumnOrder(saved: readonly string[], natural: readonly string[]): string[] {
  const present = new Set(natural);
  const out = saved.filter((id) => present.has(id));
  const placed = new Set(out);
  natural.forEach((id, i) => {
    if (placed.has(id)) return;
    // after the nearest natural predecessor already placed, or first
    let at = 0;
    for (let j = i - 1; j >= 0; j--) {
      const k = out.indexOf(natural[j]!);
      if (k >= 0) {
        at = k + 1;
        break;
      }
    }
    out.splice(at, 0, id);
    placed.add(id);
  });
  return out;
}

/** Moves a column one place earlier (-1) or later (+1) in an order. */
export function moveColumn(order: readonly string[], id: string, by: -1 | 1): string[] {
  const i = order.indexOf(id);
  const j = i + by;
  if (i < 0 || j < 0 || j >= order.length) return [...order];
  const out = [...order];
  [out[i], out[j]] = [out[j]!, out[i]!];
  return out;
}
