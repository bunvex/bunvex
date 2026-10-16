---
---

The dashboard's demo data refuses what a deployment refuses: a top-k metric's `k` outside 1–25 and a page of more than 32 000 items; it accepts metrics windows of up to 10 000 buckets, as a deployment does. The server source reports a page that is too large as the caller's mistake (`@bunvex/dashboard`, `@bunvex/dashboard-source`, not published separately).
