// The command palette's items and search (STUDY-12 §20, UI-01 §32): screens, settings pages, tables,
// functions, a document by its id, and actions — each a place to go or a thing to do. Pure, so it is
// tested without a DOM.

export type PaletteTarget = { to: string; params?: Record<string, string>; search?: Record<string, string> };

export type PaletteItem = {
  /** Stable across openings: what "recent" remembers. */
  id: string;
  kind: "screen" | "setting" | "table" | "function" | "document" | "action";
  title: string;
  /** Shown after the title, dimmed (a path, a group). */
  hint?: string;
  /** More words that should find it. */
  keywords?: string[];
} & ({ go: PaletteTarget } | { run: () => void });

export const GROUP_TITLES: Record<PaletteItem["kind"], string> = {
  screen: "Screens",
  setting: "Settings",
  table: "Tables",
  function: "Functions",
  document: "Documents",
  action: "Actions",
};

/**
 * How well `query` matches `text`: its characters in order (a subsequence), better when they are
 * consecutive, at word starts, or at the beginning; null when they are not all there.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.trim().toLowerCase();
  if (q === "") return 0;
  const t = text.toLowerCase();
  const whole = t.indexOf(q);
  if (whole >= 0) return 1000 - whole * 2 - (t.length - q.length) * 0.1 + (whole === 0 ? 200 : 0);
  let score = 0;
  let at = -1;
  let run = 0;
  for (const ch of q) {
    if (ch === " ") continue;
    const i = t.indexOf(ch, at + 1);
    if (i < 0) return null;
    const wordStart = i === 0 || /[\s/:._-]/.test(t[i - 1]!);
    run = i === at + 1 ? run + 1 : 0;
    score += 10 + run * 5 + (wordStart ? 8 : 0) - (i - at - 1) * 0.5;
    at = i;
  }
  return score;
}

/** The items matching `query`, best first; an item matches on its title, hint or keywords. */
export function searchItems(items: readonly PaletteItem[], query: string, limit = 50): PaletteItem[] {
  if (query.trim() === "") return items.slice(0, limit);
  const scored: { item: PaletteItem; score: number; i: number }[] = [];
  items.forEach((item, i) => {
    const scores = [item.title, item.hint ?? "", ...(item.keywords ?? [])].map((t, k) => {
      const s = fuzzyScore(query, t);
      return s === null ? null : s - k * 5;
    });
    const best = Math.max(...scores.map((s) => s ?? -Infinity));
    if (best > -Infinity) scored.push({ item, score: best, i });
  });
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  return scored.slice(0, limit).map((s) => s.item);
}

/** Recently picked ids, newest first, at most `max`. */
export function rememberPick(recent: readonly string[], id: string, max = 5): string[] {
  return [id, ...recent.filter((r) => r !== id)].slice(0, max);
}

/** Looks like a document id (bunvex ids: 32 base-32 characters). */
export const looksLikeId = (q: string) => /^[0-9a-z]{20,40}$/.test(q.trim());
