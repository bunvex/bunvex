---
"@bunvex/server": minor
"@bunvex/core": patch
"@bunvex/persistence": patch
---

`GET /api/debug/topology` (an admin key with ViewMetrics) reports the deployment's topology for the dashboard's
Topology screen: this process as the leader alone, with its connections, subscriptions, query cache, commits per
second, CPU and memory and a minute of samples, and the store with its driver and lease, read from counters the
server already keeps. Each persistence driver names itself (`driver`), and the engine keeps its lease's holder and
last renewal round trip (`leaseState`).
