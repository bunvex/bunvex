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

// ?latency=300&fail=0.2 in the URL exercises the loading and error states.
const params = new URLSearchParams(location.search);
const source = new MockDataSource({
  latencyMs: Number(params.get("latency") ?? 120),
  failRate: Number(params.get("fail") ?? 0),
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
