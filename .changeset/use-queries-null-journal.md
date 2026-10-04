---
"@bunvex/react": patch
---

`useQueries` (and so `useQuery`) moves a query to a new client with its journal only when there is one, as Convex. A `null` journal, which most queries have, used to be passed on, so the new client's `Add` carried `journal: null` where Convex's carries none.
