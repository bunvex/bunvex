// Package @bunvex/dashboard — the dashboard screens, fed by an injected DashboardDataSource (UI-01).
export { createDashboardQueryClient, Dashboard, type DashboardProps } from "./dashboard.tsx";
export { dashboardKeys } from "./data/queries.ts";
export * from "./data-source.ts";
export {
  createDashboardRouter,
  type DashboardRouter,
  type DashboardRouterContext,
  type DocumentsSearch,
  type LogsSearch,
} from "./router.tsx";
