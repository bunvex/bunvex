---
"@bunvex/server": patch
---

`start_push` (and `evaluate_push`) answer each module's analysis as Convex's: the crons as
`[{identifier, spec}]` in identifier order, each spec's arguments the bytes of their JSON text, and
`sourceMapped: null`. A cron with an int64 argument no longer makes the push fail with a 500. `_modules` rows
keep their crons in identifier order too, as Convex's.
