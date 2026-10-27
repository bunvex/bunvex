---
"@bunvex/server": patch
---

The audit log records log stream changes with Convex's configuration snapshots. `create_integration` and `delete_integration` carry `config`; `update_integration` (a webhook's secret rotation included) carries `previous`, `current` and `credential_changes`. The snapshots keep an allowlist of fields, cut every URL to its origin, and leave every credential out. A completed export's ZIP download is recorded as `download_export`, by the admin key's member, or by the member who asked for the download token.
