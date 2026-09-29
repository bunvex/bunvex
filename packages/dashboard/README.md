# @bunvex/dashboard

The bunvex dashboard screens — overview, tables and documents, functions, logs. It never talks to a server
itself: a host passes a `DashboardDataSource`, so the same screens serve a self-hosted deployment and a
cloud control plane. `MockDataSource` serves development and tests.

**Status:** being built — see [UI-01](../../docs/specs/UI-01-ui-and-dashboard.md) and
[ARCHITECTURE.md](../../ARCHITECTURE.md).

## Mounting it

```tsx
import { Dashboard } from "@bunvex/dashboard";
import { MockDataSource } from "@bunvex/dashboard/mock";
import { ThemeToggle } from "@bunvex/ui/components/theme-toggle";
import { ThemeProvider } from "@bunvex/ui/theme";
import { createHashHistory } from "@tanstack/react-router";

<ThemeProvider>
  <Dashboard
    dataSource={new MockDataSource()}
    history={createHashHistory()}
    headerActions={<ThemeToggle />}
    devtools={import.meta.env.DEV}
  />
</ThemeProvider>;
```

- **Routing** is TanStack Router, inside the package. The host picks the `history` (hash for a static
  host, the browser's under a `basepath` inside a larger app, memory in tests).
- **Data** goes through TanStack Query. Pass `queryClient` (and a `scope` per deployment) to share your
  client; otherwise the dashboard creates its own.
- **Styles**: the package ships no CSS. Import `@bunvex/ui/styles.css` in your stylesheet and add an
  `@source` for this package's `src/`, so Tailwind generates the classes the screens use (see
  `apps/dashboard/src/app.css`).
- **Theme**: the host owns it (`ThemeProvider` from `@bunvex/ui/theme`), and passes a toggle in
  `headerActions` if it wants one.
- **A new data source** implements `DashboardDataSource` (`@bunvex/dashboard/data-source`) and should pass
  `describeDataSourceContract` from `@bunvex/dashboard/contract` in its tests.
