// The dashboard host for development: mounts @bunvex/dashboard over the MockDataSource, with plain paths
// (`/database/users`, the browser history) and the TanStack devtools in development. A host serving the
// build answers every path with index.html (Vite's dev server and `vite preview` do).
import { Dashboard } from "@bunvex/dashboard";
import { MockDataSource } from "@bunvex/dashboard/mock";
import { ThemeToggle } from "@bunvex/ui/components/theme-toggle";
import { ThemeProvider } from "@bunvex/ui/theme";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./app.css";
import { takeDevKnobs } from "./knobs.ts";

// ?latency=300&fail=0.2&writes=500 in the URL exercises loading, errors and live data (knobs.ts).
const params = takeDevKnobs({ location, history, storage: sessionStorage });
const source = new MockDataSource({
  latencyMs: Number(params.get("latency") ?? 120),
  failRate: Number(params.get("fail") ?? 0),
  // a task inserted (or deleted) every few seconds, so the Database screen has something live to show
  liveWritesMs: Number(params.get("writes") ?? 3000),
  // ?tables=0: a deployment with no tables yet
  tables: params.get("tables") !== "0",
  // about ten calls a minute over the six hours of history, so the Health charts read as traffic;
  // ?tasks=100000&executions=… for volume, to see how the screens hold up (UI-01 §19.3)
  executions: Number(params.get("executions") ?? 4000),
  ...(params.has("tasks") && { documents: { tasks: Number(params.get("tasks")) } }),
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <Dashboard dataSource={source} headerActions={<ThemeToggle />} devtools={import.meta.env.DEV} />
    </ThemeProvider>
  </StrictMode>,
);
