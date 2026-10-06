---
"@bunvex/server": minor
"@bunvex/core": minor
"@bunvex/values": minor
---

Subscriptions and invalidation inspector (STUDY-131 AD-25, a bunvex addition). These admin endpoints need ViewMetrics:

- `GET /api/debug/subscriptions` lists every live query per sync session: function, args digest, ts, whether the result was cached, documents and bytes read, and the read set as index ranges with their bounds decoded to values. It also shows the last invalidations: commit ts, write source, table, the written key decoded, and the delay until the new result was sent. A rerun with no invalidation shows its reason.
- `GET /api/debug/query_cache` shows the query cache's counters, with misses by reason (new, evicted, invalidated, expired, snapshot), and its biggest entries with their read sets.
- `GET /api/debug/invalidations` follows new invalidations as a long poll.

The history ring holds 8 entries per execution by default. Set it with `SUBSCRIPTION_INVALIDATION_HISTORY` or the server option `invalidationHistory`; 0 turns recording off. `@bunvex/values` gains `keyToValues`, the inverse of `valuesToKey`. `@bunvex/core` gains `describeBound`, `boundText` and `keyValueText`.
