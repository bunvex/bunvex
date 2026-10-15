# @bunvex/dashboard-source

The dashboard's data source for a bunvex deployment: the `DashboardDataSource` contract of
[`@bunvex/dashboard`](../dashboard/README.md) over an admin key, one sync connection (`@bunvex/client`) and the
deployment's admin HTTP routes — the way Convex's dashboard reads a deployment
([STUDY-149](../../docs/study/STUDY-149-dashboard-real-data.md), [UI-01 §34](../../docs/specs/UI-01-ui-and-dashboard.md)).
Private: it ships inside the dashboard's build.

```ts
import { createAdminKeyVerifier, createServerDataSource } from "@bunvex/dashboard-source";

const check = await createAdminKeyVerifier().verify(url, adminKey); // GET /api/check_admin_key, 3 tries
if (check.ok) {
  const source = createServerDataSource({ url, adminKey });
  // <Dashboard dataSource={source} />; later: source.close()
}
```

**Status (STUDY-149, all eight PRs built):** the deployment, its capabilities and counters, the schema, the
deployment state (pause and resume), the logs (Convex's long poll on `stream_function_logs`) and the metrics
(PR 1); the tables and documents, live (PR 2); the writes (PR 3); the functions, the runner, the custom test query,
environment variables, authentication providers and snapshots (PR 4); the schedules, crons, files and audit log,
every read a subscription while the screen watches and the busy lists auto-paused as Convex's, and Health's
concurrency and subscription invalidations (PR 5). `apps/dashboard` runs on it since PR 6. Not offered (each
optional method left undefined, so the screen hides or says so): `fileStats`; the subscriptions inspector and the
system tables (their server side exists, AD-25 and AD-24); the topology, the clients, authentication admin and
the extensions (no server side yet). Its tests:
`test/` (no server), and `packages/sync-e2e/dashboard` (the dashboard's contract suite on a live server).
