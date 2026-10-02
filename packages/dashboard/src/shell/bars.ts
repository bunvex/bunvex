// The grid screens' frame (UI-01 §22.3, §22.5): full-bleed inside <main>, a screen's height; Bar 1 — the
// heading, the count and the actions — as tall as the docked panel's header (44 px), so their bottom lines
// continue across; Bar 2 — search and filters — under it; then the grid, filling the rest.
export const SCREEN = "-m-4 flex h-[calc(100svh-3rem)] md:-m-6";
export const BAR1 = "flex min-h-11 flex-wrap items-center gap-x-2 gap-y-1 border-b px-4 py-1 md:px-6";
export const BAR2 = "flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-2 md:px-6";
/** The heading in Bar 1. */
export const BAR_TITLE = "mr-2 text-base font-semibold tracking-tight";
