# @bunvex/dashboard

The bunvex dashboard screens — the overview (Health), the Database screen, and (being built) Functions and
Logs. It never talks to a server
itself: a host passes a `DashboardDataSource`, so the same screens serve a self-hosted deployment and a
cloud control plane. `MockDataSource` serves development and tests.

**Status:** being built, on the mock (no server data source yet) — see [UI-01](../../docs/specs/UI-01-ui-and-dashboard.md) and
[ARCHITECTURE.md](../../ARCHITECTURE.md).

## Mounting it

```tsx
import { Dashboard } from "@bunvex/dashboard";
import { MockDataSource } from "@bunvex/dashboard/mock";
import { ThemeToggle } from "@bunvex/ui/components/theme-toggle";
import { ThemeProvider } from "@bunvex/ui/theme";

<ThemeProvider>
  <Dashboard
    dataSource={new MockDataSource()}
    headerActions={<ThemeToggle />}
    devtools={import.meta.env.DEV}
  />
</ThemeProvider>;
```

- **Routing** is TanStack Router, inside the package. It uses the browser history (plain paths, so
  the host answers every path with the app); pass `basepath` inside a larger app, or another `history`
  (memory in tests).
- **Data** goes through TanStack Query. Pass `queryClient` (and a `scope` per deployment) to share your
  client; otherwise the dashboard creates its own.
- **Styles**: the package ships no CSS. Import `@bunvex/ui/styles.css` in your stylesheet and add an
  `@source` for this package's `src/`, so Tailwind generates the classes the screens use (see
  `apps/dashboard/src/app.css`).
- **Theme**: the host owns it (`ThemeProvider` from `@bunvex/ui/theme`), and passes a toggle in
  `headerActions` if it wants one.
- **A new data source** implements `DashboardDataSource` (`@bunvex/dashboard/data-source`) and should pass
  `describeDataSourceContract` from `@bunvex/dashboard/contract` in its tests.

## Accessibility

Every screen is checked with axe in its tests (`test/a11y.test.tsx` walks each screen state); colour
contrast is checked on the tokens (`@bunvex/ui`) and was checked with axe in a real browser in both themes. The Database screen works from the keyboard alone: a skip link, the sidebar,
the table list, then the grid as one tab stop (arrows move, Enter edits a field or opens the document); side panels close with Escape and give the focus back to the grid.

## Tests

`bun run test` in this package (happy-dom preloaded by `bunfig.toml`). `describeDataSourceContract` runs against `MockDataSource` here and against any other source in its
own package.
