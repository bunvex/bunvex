# STUDY-49 — Canonical URLs

- **Status:** decision pending (owner): C1; the PR implements the recommendation
- **Convex source read:** `main` of get-convex/convex-backend, 2026-10-02
- **Related:** [STUDY-37](STUDY-37-cli-and-environment-variables.md) (the built-in variables),
  [STUDY-32](STUDY-32-file-storage.md) (file URLs), [STUDY-48](STUDY-48-audit-log.md) (its events)

## 1. How Convex does it

- **The table**: `_canonical_urls` (`crates/model/src/canonical_urls`, DefaultTableNumber 34, number 546).
  - A document is `{requestDestination: "convexCloud" | "convexSite", url}`, with at most one per destination.
  - Setting the same URL again is a no-op; setting a different one replaces the row.
- **The routes** (`crates/local_backend/src/canonical_urls.rs`, platform router `/api/v1/`):
  - `POST /update_canonical_url {requestDestination, url?}` needs WriteEnvironmentVariables.
    - With `url` it sets the destination's URL and records the audit-log event `update_canonical_url {request_destination, url}`.
    - Without `url` it unsets it and records `delete_canonical_url {request_destination}`.
    - Both happen in one transaction, which also re-evaluates the deployed auth config (`set_canonical_url` in `application/src/lib.rs`).
  - `GET /get_canonical_urls` is open to any admin.
    - It answers `{convexCloudUrl, convexSiteUrl}`: the URLs set, or the backend's own origins.
- **What a URL replaces**, always read in the caller's transaction:
  - `CONVEX_CLOUD_URL` / `CONVEX_SITE_URL` for functions (`udf/src/environment.rs` `system_env_var_overrides`), in queries, mutations and actions (the action's phase);
  - the origin of upload URLs and file URLs (`file_storage/src/core.rs`).

## 2. What an app can observe

`process.env.CONVEX_CLOUD_URL` / `CONVEX_SITE_URL`, and the URLs `storage.getUrl` and
`generateUploadUrl` return. A query that read them re-runs when they change.

## 3. How bunvex does it

- **Storage and reading**: `_canonical_urls` (number 546) and `server/src/canonical-urls.ts`, which reads and sets the rows in a transaction.
- **Where the URLs apply**, each one read in the caller's transaction:
  - a query's or mutation's `process.env` (`txEnv`) and an action's variables at its start;
  - `ctx.storage.getUrl` and `generateUploadUrl`, and the dashboard's file queries;
  - `_system/cli/deploymentUrl:cloudUrl`;
  - the environment `auth.config` is evaluated in.
- **The routes**: `/api/v1/update_canonical_url` (also `/api/update_canonical_url`) and `/api/v1/get_canonical_urls`, as Convex's, with the audit-log events.
- **Measured cost**: deployed code's queries and mutations now read the (small) table. That adds about 1.3 µs per uncached execution, on top of an empty transaction's 0.4 µs.

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| C1 | The destinations are `bunvexCloud` / `bunvexSite` and `get_canonical_urls` answers `{bunvexCloudUrl, bunvexSiteUrl}` | Rule 5: no "convex" in shipped strings, as `BUNVEX_CLOUD_URL` (STUDY-37). **Not possible** under the rule | DV-263, pending |
