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

**Status (STUDY-149 PR 1):** the deployment, its capabilities and counters, the schema, the deployment state
(pause and resume), the logs (Convex's long poll on `stream_function_logs`) and the function metrics. The
tables and documents (PR 2), the writes (PR 3), the functions and runner, environment variables and settings
(PR 4), schedules, files and history (PR 5) answer `unavailable` until their server side exists. Its tests:
`test/` (no server), and `packages/sync-e2e/dashboard` (the dashboard's contract suite on a live server).
