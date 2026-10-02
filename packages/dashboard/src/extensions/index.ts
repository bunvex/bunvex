// The extensions registry (UI-01 §26): the screens the router and the sidebar add next to the built-in ones,
// and the contract features they bring. To remove an extension: delete its folder and its lines here, in
// `mock.ts` and in `contract.ts`. This module stays light — it imports declarations only; each screen is a
// lazy chunk.
import type { DashboardExtension } from "./types.ts";

/** Every extension's contract features, merged into `DashboardDataSource` (all optional methods). */
// biome-ignore lint/suspicious/noEmptyInterface: extensions add their features here
export interface ExtensionFeatures {}

export const extensions: readonly DashboardExtension[] = [];
