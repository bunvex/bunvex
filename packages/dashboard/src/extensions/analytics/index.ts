// The Analytics extension (UI-01 §26.1, STUDY-12 §16 — a bunvex addition, owner's call 1 Oct 2026, possibly
// removed later): its declaration for the registry. Live visitors are the deployment's open WebSocket sessions
// on a world map (mapcn/MapLibre over a bundled, offline basemap), with Events, Sessions and Profiles.
import { ChartNoAxesCombined } from "lucide-react";
import type { DashboardExtension } from "../types.ts";

export const ANALYTICS_SECTIONS = ["realtime", "events", "sessions", "profiles"] as const;
export type AnalyticsSection = (typeof ANALYTICS_SECTIONS)[number];

/** Events: the event name to narrow to. Every key, `undefined` when invalid. */
export const validateAnalyticsSearch = (input: Record<string, unknown>): { name?: string } => ({
  name: typeof input.name === "string" && /^[\w.:-]{1,64}$/.test(input.name) ? input.name : undefined,
});

const load = () => import("./screen.tsx");

export const analyticsExtension: DashboardExtension = {
  id: "analytics",
  title: "Analytics",
  icon: ChartNoAxesCombined,
  nav: { group: "observe", order: 10, to: "/analytics/realtime" },
  routes: [
    { path: "analytics", load, component: "AnalyticsScreen" },
    { path: "analytics/$section", load, component: "AnalyticsScreen", validateSearch: validateAnalyticsSearch },
  ],
  requires: [
    "getAnalyticsRealtime",
    "watchAnalyticsRealtime",
    "listAnalyticsEvents",
    "listAnalyticsSessions",
    "listAnalyticsProfiles",
  ],
};
