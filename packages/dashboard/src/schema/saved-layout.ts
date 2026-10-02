// What the reader changed on the schema diagram (STUDY-12 §14.6, SC1): groups renamed, and where tables and
// whole groups were dragged — kept in this browser per deployment, applied over the computed layout. A group is
// known by its id (stable for a given set of tables, `clusters.ts`), so a group whose tables change loses its
// name and place, as it is a different group. "Reset layout" forgets the positions; names stay.
export type SavedPosition = { x: number; y: number; parent: string | null };
export type SavedLayout = { names: Record<string, string>; positions: Record<string, SavedPosition> };

const key = (scope: string) => `bunvex:schema-layout:${scope}`;
export const EMPTY_LAYOUT: SavedLayout = { names: {}, positions: {} };

export function readSavedLayout(scope: string): SavedLayout {
  try {
    const raw = JSON.parse(localStorage.getItem(key(scope)) ?? "null") as Partial<SavedLayout> | null;
    if (!raw || typeof raw !== "object") return EMPTY_LAYOUT;
    const names: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw.names ?? {})) if (typeof v === "string" && v.trim()) names[k] = v;
    const positions: Record<string, SavedPosition> = {};
    for (const [k, v] of Object.entries(raw.positions ?? {}))
      if (v && Number.isFinite(v.x) && Number.isFinite(v.y))
        positions[k] = { x: v.x, y: v.y, parent: typeof v.parent === "string" ? v.parent : null };
    return { names, positions };
  } catch {
    return EMPTY_LAYOUT;
  }
}

export function writeSavedLayout(scope: string, layout: SavedLayout) {
  try {
    if (Object.keys(layout.names).length === 0 && Object.keys(layout.positions).length === 0)
      localStorage.removeItem(key(scope));
    else localStorage.setItem(key(scope), JSON.stringify(layout));
  } catch {
    // storage off (a private window): the changes last for this visit
  }
}

/** A saved position applies only where the node still sits in the same group (or none). */
export function savedPosition(
  layout: SavedLayout,
  id: string,
  parent: string | null,
): { x: number; y: number } | undefined {
  const p = layout.positions[id];
  return p && p.parent === parent ? { x: p.x, y: p.y } : undefined;
}
