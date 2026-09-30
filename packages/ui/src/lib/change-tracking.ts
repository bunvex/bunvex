// What changed between two renders of a live list, by row identity (not position): the cells whose value
// differs, and the rows that arrived between rows already shown. Rows that only appear at the end — the
// next page loading — are not "added", and a new list (a new filter) is compared with nothing.

/** Each row's cells, as comparable text, keyed by row id then column id. */
export type Snapshot = Map<string, Map<string, string>>;

/** A value as text to compare: JSON, with `undefined` distinct from every JSON value. */
export const comparable = (v: unknown): string => (v === undefined ? "\u0000unset" : (JSON.stringify(v) ?? String(v)));

export function snapshotOf(rows: { id: string; cells: [column: string, value: unknown][] }[]): Snapshot {
  return new Map(rows.map((r) => [r.id, new Map(r.cells.map(([c, v]) => [c, comparable(v)]))]));
}

export const cellKey = (rowId: string, column: string) => `${rowId}\u0000${column}`;

/**
 * `changed`: cells present in both snapshots whose value differs (a column only one side has is not a
 * change: a field that just appeared elsewhere). `added`: rows not in `prev` that have a row of `prev`
 * after them in `order` — inserted above or between, not appended.
 */
export function diffSnapshots(prev: Snapshot, next: Snapshot, order: string[]): { changed: string[]; added: string[] } {
  const changed: string[] = [];
  for (const [id, cells] of next) {
    const before = prev.get(id);
    if (!before) continue;
    for (const [column, value] of cells) {
      const was = before.get(column);
      if (was !== undefined && was !== value) changed.push(cellKey(id, column));
    }
  }
  let lastKnown = -1;
  order.forEach((id, i) => {
    if (prev.has(id)) lastKnown = i;
  });
  const added = order.filter((id, i) => i < lastKnown && !prev.has(id));
  return { changed, added };
}
