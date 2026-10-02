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
executions in the logs (each writes 1–4 lines). `?nodes=4` shows a leader and three followers on the Topology screen
(one node by default, as bunvex runs today). `?validate=pass` or `?validate=fail` starts a schema validation, as after a push, that
ends accepted or with documents that do not match (Schema screen and the Database schema panel).

## Tests

```sh
bun run test      # the dev knobs (happy-dom not needed)
bun run e2e       # builds, then Playwright against `vite preview` on :4179: every screen, axe with colour
                  # contrast in both themes, phone width, Health's first-load size
```

The end-to-end tests use the system Chrome locally and Playwright's Chromium in CI (`E2E_BROWSER=chromium`);
the CI job "e2e · dashboard in Chromium" is not a required check.

It is a host only: screens, data and styles come from `@bunvex/dashboard` and `@bunvex/ui`
([UI-01](../../docs/specs/UI-01-ui-and-dashboard.md)).

## Signing in

The app opens on a sign-in page: a deployment URL and an admin key (UI-01 §31, STUDY-12 §19). Only a mock
verifier exists for now — the dashboard does not talk to a real server yet: a key shaped `name|secret`
signs in (`name|readonly…` read-only, `name|viewer…` view-only). **Use the demo data** opens the screens on the
mock; `?demo=1` does it from the address. `VITE_BUNVEX_DEPLOYMENT_URL` / `VITE_BUNVEX_ADMIN_KEY` prefill the
form. The key lives in memory: a reload asks for it again.
