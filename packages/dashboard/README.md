# @bunvex/dashboard

The bunvex dashboard screens: Health, Topology, Database, Schema, Files, Functions (with the function
runner), Schedules, Authentication, Logs, History and Settings — the list, with where each is specified,
is [UI-01 §0](../../docs/specs/UI-01-ui-and-dashboard.md). It never talks to a server itself: a host passes a `DashboardDataSource`, so the same screens serve a self-hosted deployment and a
cloud control plane. `MockDataSource` serves development and tests.

**Status:** every screen is built on the mock; no server implements the contract yet (it needs the
server's admin API) — see [UI-01](../../docs/specs/UI-01-ui-and-dashboard.md) and
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
  `describeDataSourceContract` from `@bunvex/dashboard/contract` in its tests. Only the core methods are
  required; every other area (writes, the runner, deployment, state, metrics, snapshots, auth, auth admin,
  topology, subscriptions) is optional, detected with `typeof`, and a screen or action without its method says so or
  hides itself (UI-01 §0).

## Extensions

Experimental screens live in `src/extensions/<id>/` and are listed in three registries (UI-01 §26):
`src/extensions/index.ts` (the screen's declaration and its contract features), `src/extensions/mock.ts` (its mock
part) and `src/extensions/contract.ts` (its contract-suite part). An extension's sidebar entry shows only when the
data source has the contract methods it `requires`.

- **Remove one**: delete its folder and its line in each of the three registries — TypeScript points at any left.
- **Add one**: a folder with its declaration (`DashboardExtension`), its lazy screen(s), its optional contract
  methods, its `MockExtensionPart` and its `ContractExtensionPart`, then one line in each registry.
- A host can pass its own: `<Dashboard extensions={[...]} />`, `new MockDataSource({ extensions })`,
  `describeDataSourceContract(name, make, { extensions })`.

## Accessibility

Every screen is checked with axe in its tests (`test/a11y.test.tsx` walks each screen state); colour
contrast is checked on the tokens (`@bunvex/ui`) and was checked with axe in a real browser in both themes. Every screen works from the keyboard alone: a skip link, the sidebar, the section column, then the
grid as one tab stop (arrows move, Enter edits a field or opens the details); docked panels close with
Escape and give the focus back. The flow canvases (Schema, Topology) have focusable nodes with
descriptive labels and a text summary.

## Tests

`bun run test` in this package (happy-dom preloaded by `bunfig.toml`). `describeDataSourceContract` runs against `MockDataSource` here and against any other source in its
own package. The screens are also tested in a real browser from `apps/dashboard` (`bun run e2e`).
