---
"@bunvex/server": patch
---

The scheduled job executor counts a system error (`stats.systemErrors`) once the failed attempt is recorded on the
job, as it counts a failed job once it is stored.
