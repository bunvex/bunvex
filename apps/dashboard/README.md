# @bunvex/dashboard-app

A thin Vite host that mounts [`@bunvex/dashboard`](../../packages/dashboard) over the `MockDataSource`, with
hash routing (a static host needs no rewrite rules) and the TanStack devtools in development. Private.

```sh
bun run dev       # http://localhost:5173
bun run build     # dist/, served by any static host
bun run preview   # the built app
```

Query parameters on the page tune the mock, to see loading, errors and live data:
`?latency=300` (ms per call), `?fail=0.2` (share of calls that fail), `?writes=500` (a live insert or
delete every 500 ms; `0` turns it off).

It is a host only: screens, data and styles come from `@bunvex/dashboard` and `@bunvex/ui`
([UI-01](../../docs/specs/UI-01-ui-and-dashboard.md)).
