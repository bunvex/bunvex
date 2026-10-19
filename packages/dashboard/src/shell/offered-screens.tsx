// Built-in screens a source may not offer (STUDY-149 follow-up). bunvex's own screens (additions, STUDY-12 D1) need
// source methods a deployment may not have yet. Like an extension's `requires` (extensions/types.ts), a screen
// listed here is in the sidebar and the command palette only when the source has every method it requires, and
// its route says the deployment does not offer it (a typed URL, a link). Convex's own screens (Database, Files,
// Schedules, History, …) are not listed: they stay in the sidebar whatever the source, as Convex's sidebar lists
// them (UI-01 §14.2). A source that gains a method (AD-25's subscriptions, AD-04's topology) shows its screen
// with no change here.
import type { ComponentType, ReactNode } from "react";
import { useQueryScope } from "../context.tsx";
import type { DashboardDataSource } from "../data-source.ts";
import { NotOffered } from "./not-offered.tsx";

type OfferedScreen = {
  /** The screen's name, as the sidebar shows it. */
  title: string;
  /** What "This deployment does not offer … yet" names. */
  what: string;
  /** The source methods the screen needs, all of them (`typeof source[m] === "function"`). */
  requires: readonly (keyof DashboardDataSource)[];
};

/** By the screen's path; its pages (`/auth/users`) are its own. */
export const OFFERED_SCREENS: Readonly<Record<string, OfferedScreen>> = {
  "/topology": { title: "Topology", what: "its topology", requires: ["getTopology"] },
  "/auth": { title: "Authentication", what: "user management", requires: ["listAuthUsers"] },
  "/subscriptions": { title: "Subscriptions", what: "a view of its live queries", requires: ["getSubscriptions"] },
  // AD-43: a deployment without rooms still has the method (it answers `not_found`, and the screen says so)
  "/rooms": { title: "Rooms", what: "a view of its rooms and presence scopes", requires: ["listRooms"] },
};

/** The entry `to` falls under (`/auth/users` under `/auth`), if any. */
function entryOf(to: string): OfferedScreen | undefined {
  for (const [path, entry] of Object.entries(OFFERED_SCREENS))
    if (to === path || to.startsWith(`${path}/`) || to.startsWith(`${path}?`)) return entry;
  return undefined;
}

/** Whether the source offers the screen at `to`: a screen not listed above always is. */
export function screenOffered(source: DashboardDataSource, to: string): boolean {
  const entry = entryOf(to);
  return !entry || entry.requires.every((m) => typeof source[m] === "function");
}

/** A screen's route: the screen when the source offers it, else "This deployment does not offer … yet". */
export function offeredOnly(
  path: keyof typeof OFFERED_SCREENS,
  Screen: ComponentType & { preload?: () => Promise<void> | undefined },
): (() => ReactNode) & { preload?: () => Promise<void> | undefined } {
  const entry = OFFERED_SCREENS[path]!;
  function OfferedRoute(): ReactNode {
    const { source } = useQueryScope();
    if (!screenOffered(source, path)) return <NotOffered title={entry.title} what={entry.what} />;
    return <Screen />;
  }
  OfferedRoute.displayName = `Offered(${path})`;
  // a lazy screen keeps its preload (the router calls it on a link's intent)
  if (Screen.preload) OfferedRoute.preload = Screen.preload;
  return OfferedRoute;
}
