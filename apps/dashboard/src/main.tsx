// The dashboard host for development: mounts @bunvex/dashboard over the MockDataSource, routing on the
// hash (a static host needs no rewrite rules), with the TanStack devtools in development.
import { Dashboard } from "@bunvex/dashboard";
import { MockDataSource } from "@bunvex/dashboard/mock";
import { ThemeToggle } from "@bunvex/ui/components/theme-toggle";
import { ThemeProvider } from "@bunvex/ui/theme";
import { createHashHistory } from "@tanstack/react-router";
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
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <Dashboard
        dataSource={source}
        history={createHashHistory()}
        headerActions={<ThemeToggle />}
        devtools={import.meta.env.DEV}
      />
    </ThemeProvider>
  </StrictMode>,
);
