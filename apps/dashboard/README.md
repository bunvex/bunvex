# @bunvex/dashboard-app

A thin Vite host that mounts [`@bunvex/dashboard`](../../packages/dashboard) over the `MockDataSource`, with
plain paths (`/database/users`) and the TanStack devtools in development. Private.

```sh
bun run dev       # http://localhost:5173
bun run build     # dist/: a static host that answers unknown paths with index.html
bun run preview   # the built app
```

`/design-system.html` shows `@bunvex/ui`'s tokens and components in both themes (UI-01 §17.5).

Query parameters on any page tune the mock (they are taken out of the address and kept for the tab), to see loading, errors and live data:
`?latency=300` (ms per call), `?fail=0.2` (share of calls that fail), `?writes=500` (a live insert or
delete every 500 ms; `0` turns it off), `?tables=0` (a deployment with no tables yet). `?tasks=100000&executions=4000` give volume: that many tasks, and that many function
executions in the logs (each writes 1–4 lines).

It is a host only: screens, data and styles come from `@bunvex/dashboard` and `@bunvex/ui`
([UI-01](../../docs/specs/UI-01-ui-and-dashboard.md)).
